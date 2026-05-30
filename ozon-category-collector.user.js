// ==UserScript==
// @name         Ozon 类目批量采集器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  批量展开、采集 Ozon 卖家后台类目树，导出 CSV。使用前先点击「类目」按钮打开类目筛选弹窗/下拉框。
// @author       You
// @match        https://seller.ozon.ru/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置区 ====================
    const CONFIG = {
        maxExpandRounds: 80,       // 最大展开轮数（防死循环）
        expandDelay: 250,          // 每轮展开后等待 ms
        stableThreshold: 3,        // 连续 N 轮无新内容则判定展开完成
        scrollStep: 800,           // 虚拟滚动步进 px
        debug: false               // 调试模式（输出到控制台）
    };

    let collectedData = [];
    let isExpanding = false;
    let autoDetectTimer = null;

    // ==================== 工具函数 ====================
    function log(...args) {
        console.log('%c[Ozon类目采集]', 'color:#005bff;font-weight:bold;', ...args);
    }
    function debug(...args) {
        if (CONFIG.debug) console.log('%c[OzonDebug]', 'color:#f57c00;', ...args);
    }
    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    // ==================== DOM 查找策略（多策略兜底） ====================

    /**
     * 查找类目树容器
     * 采用三层策略，逐步放宽匹配条件
     */
    function findTreeContainer() {
        // ── 策略1：语义选择器（data-testid / class 关键词） ──
        const semanticSelectors = [
            '[data-testid*="category"][data-testid*="tree"]',
            '[data-testid*="category-tree"]',
            '[data-testid*="categoryTree"]',
            '[class*="category-tree" i]',
            '[class*="categoryTree" i]',
            '[class*="CategoryTree" i]',
            '[class*="tree-select" i]',
            '[class*="tree_select" i]',
        ];
        for (const sel of semanticSelectors) {
            const el = document.querySelector(sel);
            if (el) {
                debug('✓ 树容器 (语义选择器):', sel, el);
                return el;
            }
        }

        // ── 策略2：智能评分 —— 找包含 checkbox + 展开图标 + 树形结构的最大容器 ──
        const candidates = document.querySelectorAll('div, ul, ol');
        let best = null, bestScore = 0;

        candidates.forEach(el => {
            // 必须是可见的、有一定大小的容器
            const rect = el.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 150) return;

            let score = 0;
            // checkbox 计分高
            score += el.querySelectorAll('input[type="checkbox"]').length * 5;
            score += el.querySelectorAll('[role="checkbox"]').length * 4;
            score += el.querySelectorAll('[aria-checked]').length * 4;
            // 展开/折叠相关
            score += el.querySelectorAll('[aria-expanded], [class*="expand" i], [class*="toggle" i], [class*="collapse" i]').length * 3;
            score += el.querySelectorAll('svg[class*="arrow" i], svg[class*="chevron" i], svg[class*="expand" i]').length * 2;
            // 树节点
            score += el.querySelectorAll('[role="treeitem"]').length * 3;
            // 文本节点数量（类目名）
            const textNodes = el.querySelectorAll('span, div');
            let textCount = 0;
            textNodes.forEach(n => {
                const t = n.childNodes[0];
                if (t && t.nodeType === 3 && t.textContent.trim().length > 1) textCount++;
            });
            score += textCount * 0.5;

            // 减去嵌套过深的惩罚（避免选中 body）
            let depth = 0, p = el;
            while (p) { depth++; p = p.parentElement; }
            score -= depth * 0.3;

            if (score > bestScore && score > 8) {
                bestScore = score;
                best = el;
            }
        });

        if (best) {
            debug('✓ 树容器 (智能评分): score=' + bestScore.toFixed(1), best);
            return best;
        }

        // ── 策略3：弹窗/下拉内容区兜底 ──
        // 如果当前有打开的弹窗或下拉，找其中内容最多的区域
        const overlays = document.querySelectorAll([
            '[class*="modal" i] [class*="content" i]:not([class*="modal-overlay" i])',
            '[class*="dropdown" i] [class*="menu" i]',
            '[class*="popover" i] [class*="content" i]',
            '[class*="popup" i]',
            '[class*="select-dropdown" i]',
            '[class*="picker-dropdown" i]',
        ].join(','));

        for (const ov of overlays) {
            const rect = ov.getBoundingClientRect();
            if (rect.width > 150 && rect.height > 200 && ov.querySelectorAll('div').length > 10) {
                // 进一步确认里面确实有 checkbox 或 treeitem
                if (ov.querySelector('input[type="checkbox"], [role="treeitem"], [aria-expanded]')) {
                    debug('✓ 树容器 (弹窗内容区):', ov);
                    return ov;
                }
            }
        }

        debug('✗ 未找到树容器');
        return null;
    }

    /**
     * 在容器内查找所有可展开但尚未展开的按钮/图标
     */
    function findCollapsedExpanders(container) {
        if (!container) return [];
        const found = new Set();

        // 方式A：通过 aria-expanded="false"
        container.querySelectorAll('[aria-expanded="false"]').forEach(el => found.add(el));

        // 方式B：通过展开相关的 class（未展开状态）
        const classHints = [
            '[class*="expand" i]:not([class*="expanded" i]):not([class*="open" i])',
            '[class*="toggle" i]:not([class*="open" i])',
            '[class*="collapse" i]:not([class*="collapsed" i])',
            '[class*="arrow-right" i]',
            '[class*="chevron-right" i]',
        ];
        classHints.forEach(sel => {
            container.querySelectorAll(sel).forEach(el => {
                // 排除已经展开的元素
                if (el.closest('[aria-expanded="true"]') || el.closest('[class*="expanded" i]') || el.closest('[class*="open" i]')) return;
                found.add(el);
            });
        });

        // 方式C：SVG 图标（通常是小箭头）
        const svgs = container.querySelectorAll('svg');
        svgs.forEach(svg => {
            const rect = svg.getBoundingClientRect();
            // 过滤：小尺寸、可见的 SVG，且不是选中的状态
            if (rect.width > 0 && rect.height > 0 && rect.width < 40 && rect.height < 40) {
                const parent = svg.closest('[aria-expanded="true"]');
                if (!parent) found.add(svg);
            }
        });

        // 方式D：寻找每个树节点左侧的 clickable 小区域
        const treeItems = container.querySelectorAll('[role="treeitem"]');
        treeItems.forEach(item => {
            // 如果这个 treeitem 有子节点组但组是空的/隐藏的，说明需要展开
            const childGroup = item.querySelector('[role="group"]') || item.querySelector('ul, ol');
            if (!childGroup || childGroup.children.length === 0) {
                // 找这个 item 里的第一个小 clickable 元素（通常是展开按钮）
                const firstClickable = item.querySelector('button, [tabindex], svg');
                if (firstClickable) {
                    const expanded = firstClickable.getAttribute('aria-expanded');
                    if (expanded !== 'true') found.add(firstClickable);
                }
            }
        });

        // 去重 & 转成 clickable 元素
        const result = [];
        found.forEach(el => {
            let clickable = el;
            // 向上找到真正可点击的元素（button 或带 cursor:pointer 的 div）
            while (clickable && clickable !== container) {
                const tag = clickable.tagName.toLowerCase();
                const style = window.getComputedStyle(clickable);
                if (tag === 'button' || tag === 'a' || style.cursor === 'pointer' || clickable.onclick) {
                    break;
                }
                clickable = clickable.parentElement;
            }
            if (clickable && clickable !== container) {
                result.push(clickable);
            } else {
                result.push(el);
            }
        });

        const unique = [...new Set(result)];
        debug(`找到 ${unique.length} 个待展开节点 (去重前 ${result.length})`);
        return unique;
    }

    /**
     * 查找所有已选中的类目项
     */
    function findCheckedItems(container) {
        if (!container) return [];
        const checked = new Set();

        // 原生 checkbox
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (cb.checked) checked.add(cb);
        });

        // aria-checked="true"
        container.querySelectorAll('[aria-checked="true"]').forEach(el => {
            checked.add(el);
        });

        // checked/selected class（需要排除祖先未选中的情况，通过找最小单元）
        container.querySelectorAll('[class*="checked" i], [class*="selected" i]').forEach(el => {
            // 只保留叶子级别的选中元素（最小匹配）
            const childChecked = el.querySelector('[class*="checked" i], [class*="selected" i]');
            if (!childChecked) checked.add(el);
        });

        debug(`找到 ${checked.size} 个选中项`);
        return [...checked];
    }

    /**
     * 从节点向上回溯，构建完整路径
     */
    function buildFullPath(node, container) {
        const pathNames = [];
        let current = node;

        // 先找到当前节点对应的「行/节点」元素
        // 策略：向上查找直到遇到 treeitem 或一个包含 checkbox 的层级块
        let row = current;
        for (let i = 0; i < 6; i++) {
            if (!row || row === container) break;
            if (row.getAttribute('role') === 'treeitem' ||
                row.querySelector('input[type="checkbox"], [role="checkbox"]') ||
                row.getAttribute('aria-expanded') !== null) {
                break;
            }
            row = row.parentElement;
        }

        // 从 row 向上回溯收集各级名称
        current = row;
        while (current && current !== container) {
            const name = extractNodeName(current);
            if (name && name !== '未知类目' && !pathNames.includes(name)) {
                pathNames.unshift(name);
            }

            // 向上找到父级 treeitem / 节点
            let parent = current.parentElement;
            for (let i = 0; i < 4; i++) {
                if (!parent || parent === container) break;
                if (parent.getAttribute('role') === 'treeitem' ||
                    parent.querySelector('input[type="checkbox"], [role="checkbox"]')) {
                    break;
                }
                parent = parent.parentElement;
            }
            current = parent;
        }

        const leafName = pathNames[pathNames.length - 1] || extractNodeName(row) || '未知类目';
        return {
            fullPath: pathNames.join(' > '),
            depth: pathNames.length,
            name: leafName
        };
    }

    /**
     * 从单个节点提取类目名称文本
     */
    function extractNodeName(node) {
        if (!node) return '';

        // 策略1：找直接子文本节点最长的 span/div
        const textEls = node.querySelectorAll('span, div, label');
        let bestText = '', bestLen = 0;

        for (const el of textEls) {
            // 只取直接文本（避免把子节点文本也带进来）
            const directText = Array.from(el.childNodes)
                .filter(n => n.nodeType === 3)
                .map(n => n.textContent.trim())
                .join('');

            if (directText.length > bestLen && directText.length < 200 && directText.length > 0) {
                // 排除纯数字或特殊符号
                if (/[\u4e00-\u9fa5a-zA-Zа-яА-Я]/.test(directText)) {
                    bestLen = directText.length;
                    bestText = directText;
                }
            }
        }

        if (bestText) return bestText;

        // 策略2：直接取所有文本
        const allText = node.textContent.trim().split('\n')[0].trim();
        if (allText.length > 0 && allText.length < 200) return allText;

        return '';
    }

    /**
     * 判断一个节点是否为叶子节点（没有子类目）
     */
    function isLeafNode(node, container) {
        if (!node) return true;

        // 有 aria-expanded 属性说明有子节点
        const hasExpand = node.querySelector('[aria-expanded]') ||
                          node.querySelector('svg, [class*="expand" i], [class*="toggle" i]');
        if (!hasExpand) return true;

        // 检查是否有可见的子节点组
        const childGroup = node.querySelector('[role="group"]') ||
                           node.querySelector('ul, ol');
        if (!childGroup) return true;

        return false;
    }

    // ==================== 核心功能 ====================

    /**
     * 展开全部类目（递归处理虚拟滚动）
     */
    async function expandAll() {
        if (isExpanding) {
            alert('正在展开中，请稍候...');
            return;
        }

        const container = findTreeContainer();
        if (!container) {
            alert('未找到类目树！\n\n请先点击「类目」按钮打开类目筛选弹窗/下拉框，\n然后再点击「展开全部」。');
            return;
        }

        isExpanding = true;
        updateStatus('展开中...');
        log('开始展开全部类目');

        let round = 0;
        let stableRounds = 0;
        let lastCount = -1;

        while (round < CONFIG.maxExpandRounds && stableRounds < CONFIG.stableThreshold) {
            // ── 触发虚拟滚动加载 ──
            const oldScrollTop = container.scrollTop;
            container.scrollTop = container.scrollHeight;
            await sleep(100);

            // ── 查找当前所有待展开节点 ──
            const toExpand = findCollapsedExpanders(container);

            if (toExpand.length === 0) {
                stableRounds++;
            } else {
                stableRounds = 0;
                // 逐个点击（避免批量触发导致页面卡顿）
                for (const btn of toExpand) {
                    try {
                        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
                        btn.click();
                    } catch (e) {
                        debug('点击展开按钮失败:', e);
                    }
                }
            }

            debug(`第 ${round + 1} 轮: 展开 ${toExpand.length} 个, 稳定 ${stableRounds}/${CONFIG.stableThreshold}`);
            updateStatus(`展开中... 第 ${round + 1} 轮 (本次展开 ${toExpand.length} 个)`);

            await sleep(CONFIG.expandDelay);
            round++;
        }

        isExpanding = false;
        const msg = stableRounds >= CONFIG.stableThreshold
            ? `展开完成！共 ${round} 轮`
            : `展开结束（达到最大轮数 ${CONFIG.maxExpandRounds}）`;
        updateStatus(msg);
        log(msg);
    }

    /**
     * 采集所有已选中的类目
     */
    function collectSelected() {
        const container = findTreeContainer();
        if (!container) {
            alert('未找到类目树！\n\n请先点击「类目」按钮打开类目筛选弹窗。');
            return;
        }

        const checked = findCheckedItems(container);
        if (checked.length === 0) {
            alert('未找到选中的类目！\n\n请在类目树中勾选需要的类目，然后再点击「采集选中」。');
            return;
        }

        collectedData = [];
        const seen = new Set();

        checked.forEach(item => {
            // 找到对应的行/节点元素
            let row = item;
            for (let i = 0; i < 6; i++) {
                if (!row || row === container) break;
                // treeitem 或包含 expand 的节点就是行级元素
                if (row.getAttribute('role') === 'treeitem' ||
                    row.querySelector('[aria-expanded], svg, [class*="expand" i]')) {
                    break;
                }
                row = row.parentElement;
            }

            const info = buildFullPath(item, container);
            const key = info.fullPath;

            if (!seen.has(key)) {
                seen.add(key);
                collectedData.push({
                    fullPath: info.fullPath,
                    depth: info.depth,
                    name: info.name,
                    isLeaf: isLeafNode(row, container) ? '是' : '否'
                });
            }
        });

        updateStatus(`已采集 ${collectedData.length} 条类目`);
        renderResults();
        log('采集完成:', collectedData);
    }

    /**
     * 渲染结果到面板表格
     */
    function renderResults() {
        const tbody = document.getElementById('ozon-collector-tbody');
        if (!tbody) return;

        if (collectedData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">暂无数据，先点击「采集选中」</td></tr>';
            return;
        }

        tbody.innerHTML = collectedData.map((item, i) => `
            <tr>
                <td style="text-align:center;color:#999;">${i + 1}</td>
                <td>${escapeHtml(item.fullPath)}</td>
                <td style="text-align:center;">${item.depth}</td>
                <td style="text-align:center;">${item.isLeaf}</td>
            </tr>
        `).join('');
    }

    /**
     * 下载 CSV（UTF-8-BOM，Excel 直接打开不乱码）
     */
    function downloadCSV() {
        if (collectedData.length === 0) {
            alert('没有数据！请先点击「采集选中」。');
            return;
        }

        const headers = ['完整路径', '层级深度', '类目名称', '是否叶子节点'];
        const rows = collectedData.map(d => [
            d.fullPath,
            d.depth,
            d.name,
            d.isLeaf
        ]);

        const csv = [
            headers.join(','),
            ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        ].join('\r\n');

        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const ts = new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).replace(/[/:]/g, '-').replace(/\s/g, '_');

        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-categories-${ts}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        updateStatus(`CSV 已下载: ${collectedData.length} 条`);
    }

    /**
     * 一键展开 + 采集（如果用户想一次性执行）
     */
    async function expandAndCollect() {
        await expandAll();
        // 等待一下让 DOM 稳定
        await sleep(500);
        collectSelected();
    }

    // ==================== UI 面板 ====================

    function updateStatus(text) {
        const el = document.getElementById('ozon-collector-status');
        if (el) el.textContent = text;
    }

    function initUI() {
        if (document.getElementById('ozon-category-collector')) return;

        const panel = document.createElement('div');
        panel.id = 'ozon-category-collector';
        panel.innerHTML = `
            <div id="ozon-collector-header">
                <span>📂 Ozon 类目采集器</span>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button id="ozon-collector-minimize" title="最小化">−</button>
                    <button id="ozon-collector-close" title="关闭">×</button>
                </div>
            </div>
            <div id="ozon-collector-body">
                <div id="ozon-collector-buttons">
                    <button id="ozon-btn-expand" title="递归展开所有类目节点">展开全部</button>
                    <button id="ozon-btn-collect" title="采集当前勾选的类目">采集选中</button>
                    <button id="ozon-btn-download" title="导出为 CSV 表格">下载 CSV</button>
                </div>
                <div id="ozon-collector-options">
                    <label title="控制台输出详细匹配日志，用于排查问题">
                        <input type="checkbox" id="ozon-debug-toggle"> 调试模式
                    </label>
                    <button id="ozon-btn-detect" style="margin-left:8px;padding:2px 8px;font-size:11px;border:1px solid #ddd;border-radius:4px;background:#fafafa;cursor:pointer;">检测树</button>
                </div>
                <div id="ozon-collector-status">就绪 — 请先打开「类目」筛选弹窗</div>
                <div id="ozon-collector-results">
                    <table>
                        <thead>
                            <tr>
                                <th style="width:30px;text-align:center;">#</th>
                                <th>完整路径</th>
                                <th style="width:45px;text-align:center;">深度</th>
                                <th style="width:45px;text-align:center;">叶子</th>
                            </tr>
                        </thead>
                        <tbody id="ozon-collector-tbody">
                            <tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">暂无数据</td></tr>
                        </tbody>
                    </table>
                </div>
                <div style="margin-top:8px;font-size:11px;color:#999;text-align:center;">
                    共 <span id="ozon-result-count">0</span> 条 · 点击表头可排序
                </div>
            </div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            #ozon-category-collector {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 440px;
                max-height: 620px;
                background: #ffffff;
                border-radius: 14px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
                font-size: 13px;
                color: #333;
                z-index: 2147483647;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                line-height: 1.5;
                transition: transform 0.2s ease, opacity 0.2s ease;
            }
            #ozon-category-collector.minimized #ozon-collector-body {
                display: none !important;
            }
            #ozon-collector-header {
                background: linear-gradient(135deg, #005bff 0%, #003d99 100%);
                color: #fff;
                padding: 12px 16px;
                font-weight: 600;
                font-size: 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
                user-select: none;
                flex-shrink: 0;
            }
            #ozon-collector-header button {
                background: rgba(255,255,255,0.15);
                border: none;
                color: #fff;
                font-size: 16px;
                cursor: pointer;
                width: 26px;
                height: 26px;
                line-height: 26px;
                text-align: center;
                border-radius: 6px;
                padding: 0;
                transition: background 0.15s;
            }
            #ozon-collector-header button:hover {
                background: rgba(255,255,255,0.3);
            }
            #ozon-collector-body {
                padding: 14px 16px 16px;
                overflow-y: auto;
                flex: 1;
                min-height: 0;
            }
            #ozon-collector-buttons {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
            }
            #ozon-collector-buttons button {
                flex: 1;
                padding: 9px 6px;
                border: none;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            #ozon-collector-buttons button:active {
                transform: scale(0.97);
            }
            #ozon-btn-expand {
                background: #e8f0fe;
                color: #1967d2;
            }
            #ozon-btn-expand:hover {
                background: #d2e3fc;
            }
            #ozon-btn-collect {
                background: #e6f4ea;
                color: #1e8e3e;
            }
            #ozon-btn-collect:hover {
                background: #ceead6;
            }
            #ozon-btn-download {
                background: #fef3e8;
                color: #e37400;
            }
            #ozon-btn-download:hover {
                background: #fce8cc;
            }
            #ozon-collector-options {
                display: flex;
                align-items: center;
                margin-bottom: 8px;
                font-size: 12px;
                color: #666;
            }
            #ozon-collector-options input[type="checkbox"] {
                margin-right: 4px;
                cursor: pointer;
            }
            #ozon-collector-options label {
                cursor: pointer;
                display: flex;
                align-items: center;
            }
            #ozon-collector-status {
                font-size: 12px;
                color: #666;
                margin-bottom: 10px;
                padding: 6px 10px;
                background: #f8f9fa;
                border-radius: 6px;
                border-left: 3px solid #005bff;
            }
            #ozon-collector-results {
                max-height: 280px;
                overflow-y: auto;
                border: 1px solid #e8eaed;
                border-radius: 8px;
                background: #fafbfc;
            }
            #ozon-collector-results table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
            }
            #ozon-collector-results th,
            #ozon-collector-results td {
                padding: 7px 8px;
                text-align: left;
                border-bottom: 1px solid #e8eaed;
                white-space: nowrap;
            }
            #ozon-collector-results th {
                background: #f1f3f4;
                font-weight: 600;
                position: sticky;
                top: 0;
                color: #5f6368;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
            }
            #ozon-collector-results tr:last-child td {
                border-bottom: none;
            }
            #ozon-collector-results tr:hover td {
                background: #e8f0fe;
            }
            #ozon-collector-results td:nth-child(2) {
                white-space: normal;
                word-break: break-all;
                max-width: 260px;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(panel);

        // ── 事件绑定 ──
        document.getElementById('ozon-btn-expand').onclick = expandAll;
        document.getElementById('ozon-btn-collect').onclick = collectSelected;
        document.getElementById('ozon-btn-download').onclick = downloadCSV;
        document.getElementById('ozon-collector-close').onclick = () => panel.remove();
        document.getElementById('ozon-collector-minimize').onclick = () => panel.classList.toggle('minimized');
        document.getElementById('ozon-debug-toggle').onchange = (e) => {
            CONFIG.debug = e.target.checked;
            log('调试模式:', CONFIG.debug ? '已开启' : '已关闭');
        };
        document.getElementById('ozon-btn-detect').onclick = () => {
            const c = findTreeContainer();
            if (c) {
                updateStatus('已检测到类目树 ✓');
                log('手动检测成功:', c);
            } else {
                updateStatus('未检测到类目树 ✗ — 请确保弹窗已打开');
                log('手动检测失败');
            }
        };

        // ── 拖拽 ──
        let dragging = false, offset = { x: 0, y: 0 };
        const header = document.getElementById('ozon-collector-header');

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offset.x = e.clientX - rect.left;
            offset.y = e.clientY - rect.top;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offset.x) + 'px';
            panel.style.top = (e.clientY - offset.y) + 'px';
        });
        document.addEventListener('mouseup', () => dragging = false);

        // ── 自动检测类目树 ──
        autoDetectTimer = setInterval(() => {
            const c = findTreeContainer();
            const status = document.getElementById('ozon-collector-status');
            if (c && status && status.textContent.includes('请先打开')) {
                updateStatus('就绪 — 已检测到类目树 ✓');
            }
        }, 1500);

        log('Ozon 类目采集器已加载 v1.0');
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
