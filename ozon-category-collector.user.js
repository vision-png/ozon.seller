// ==UserScript==
// @name         Ozon 类目批量采集器
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  批量展开、采集 Ozon 卖家后台类目树，导出 CSV。FAB 悬浮按钮 + 展开式操作面板。支持 Ozon 自定义 checkbox。
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

        // ── 策略3：基于 Ozon 特有元素检测 ──
        // Ozon 的下拉面板通常包含「应用」按钮、自定义蓝色 checkbox 等
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
            const text = div.textContent.trim();
            // 包含「应用」按钮 + 搜索框 + checkbox 行，且可见
            if (text.includes('应用') || text.includes('Применить') || text.includes('Apply')) {
                const rect = div.getBoundingClientRect();
                if (rect.width > 200 && rect.height > 150) {
                    // 检查里面是否有 checkbox（原生或自定义）
                    if (div.querySelector('input[type="checkbox"], [class*="checked" i], [class*="checkbox" i], svg')) {
                        debug('✓ 树容器 (Ozon 面板特征):', div);
                        return div;
                    }
                }
            }
        }

        // ── 策略4：弹窗/下拉内容区兜底 ──
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
                if (ov.querySelector('input[type="checkbox"], [role="treeitem"], [aria-expanded], [class*="checked" i], [class*="checkbox" i]')) {
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
     * 支持：原生 checkbox、aria-checked、class 含 checked/selected、
     * 以及 Ozon 风格的自定义 checkbox（选中状态的 SVG 或特定 class 组合）
     */
    function findCheckedItems(container) {
        if (!container) return [];
        const checked = new Set();

        // ── 方式1：原生 checkbox ──
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (cb.checked) checked.add(cb);
        });

        // ── 方式2：aria-checked="true" ──
        container.querySelectorAll('[aria-checked="true"]').forEach(el => {
            checked.add(el);
        });

        // ── 方式3：class 含 checked/selected（取叶子级，避免祖先膨胀） ──
        container.querySelectorAll('[class*="checked" i], [class*="selected" i]').forEach(el => {
            const childChecked = el.querySelector('[class*="checked" i], [class*="selected" i]');
            if (!childChecked) checked.add(el);
        });

        // ── 方式4：Ozon 自定义 checkbox — 通过 SVG 内容识别选中状态 ──
        // Ozon 的 checkbox 是一个 <svg> 元素，选中时内部包含对勾路径
        // 策略：找包含对勾 SVG 的行级元素
        const allSvgs = container.querySelectorAll('svg');
        allSvgs.forEach(svg => {
            const inner = svg.innerHTML || svg.outerHTML;
            // 检测对勾/勾选路径（polyline checkmark、path checkmark 等）
            const isCheckmark = inner.includes('polyline') ||
                                 inner.includes('M5 13l4 4L19 7') ||
                                 inner.includes('M4.5 12.5l3') ||
                                 inner.includes('check') ||
                                 // 圆角矩形 + 对勾的组合（Ozon 常见）
                                 (svg.querySelector('rect, circle') && svg.querySelector('polyline, path'));
            if (isCheckmark) {
                // 向上找到最近的「行」容器
                const row = findClosestRow(svg, container);
                if (row) checked.add(row);
            }
        });

        // ── 方式5：通过 computed style 检测自定义勾选框 ──
        // Ozon checkbox 选中时背景为蓝色(#005bff)，未选中时为灰色/透明
        container.querySelectorAll('svg').forEach(svg => {
            const rect = svg.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return;
            // 14~20px 的方形 SVG 通常是 checkbox
            if (rect.width > 20 || rect.height > 20) return;
            // 检查自身或父元素的背景色是否为蓝色（选中状态）
            let checkTarget = svg.closest('div') || svg;
            const style = window.getComputedStyle(checkTarget);
            const bgColor = style.backgroundColor;
            // #005bff 或 rgb(0, 91, 255) 表示选中
            if (bgColor === 'rgb(0, 91, 255)' || bgColor === 'rgb(0, 91, 255)' ||
                bgColor.includes('0, 91, 255') || bgColor.includes('0,91,255')) {
                const row = findClosestRow(svg, container);
                if (row) checked.add(row);
            }
        });

        debug(`找到 ${checked.size} 个选中项`);
        return [...checked];
    }

    /**
     * 向上查找最近的「行」级容器
     * 适配 Ozon 平铺式列表（每行是一个 div 容器）
     */
    function findClosestRow(el, container) {
        let current = el;
        for (let i = 0; i < 10; i++) {
            if (!current || current === container || current === document.body) return null;
            // 如果当前元素有 sibling（兄弟元素），说明它是一个行的子元素
            const parent = current.parentElement;
            if (parent && parent.children.length > 1) {
                // 检查这个父级是否像一个行容器
                const pRect = parent.getBoundingClientRect();
                // 行通常有合理的宽度但不至于太宽
                if (pRect.width > 80 && pRect.height > 20 && pRect.height < 200) {
                    return parent;
                }
            }
            current = parent || current.parentElement;
        }
        return current || el;
    }

    /**
     * 从节点向上回溯，构建完整路径
     * 适配两种结构：
     *   A) 标准 tree 结构（role="treeitem" + 嵌套）
     *   B) Ozon 平铺列表（通过 padding-left / margin-left 缩进表示层级）
     */
    function buildFullPath(node, container) {
        const pathNames = [];
        let current = node;

        // 先找到当前节点对应的「行/节点」元素
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

        // ── 方式A：标准树结构回溯 ──
        current = row;
        while (current && current !== container) {
            const name = extractNodeName(current);
            if (name && name !== '未知类目' && !pathNames.includes(name)) {
                pathNames.unshift(name);
            }

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

        // 如果方式A成功获取到路径，直接返回
        if (pathNames.length > 0) {
            return {
                fullPath: pathNames.join(' > '),
                depth: pathNames.length,
                name: pathNames[pathNames.length - 1]
            };
        }

        // ── 方式B：平铺列表结构 — 通过缩进级别推断层级 ──
        // 找到当前行以及所有同级的行，根据缩进构建树
        return buildPathFromFlatList(row, container);
    }

    /**
     * 从平铺列表构建路径（Ozon 常见模式）
     * 通过比较行的 padding-left / margin-left 来推断父子关系
     */
    function buildPathFromFlatList(row, container) {
        if (!row || !container) return { fullPath: '未知类目', depth: 1, name: '未知类目' };

        const rowIndent = getElementIndent(row);
        const name = extractNodeName(row) || '未知类目';

        // 收集所有行的缩进信息
        const allRows = getAllRows(container);
        const rowStack = []; // 缩进栈

        for (const r of allRows) {
            const indent = getElementIndent(r);
            const rName = extractNodeName(r) || '';

            // 维护栈：缩进大于栈顶则入栈，否则弹出直到找到父级
            while (rowStack.length > 0 && indent <= rowStack[rowStack.length - 1].indent) {
                rowStack.pop();
            }
            rowStack.push({ indent, name: rName, el: r });

            // 如果是目标行，构建路径
            if (r === row || r.contains(row) || row.contains(r)) {
                const path = rowStack.map(s => s.name).filter(Boolean);
                return {
                    fullPath: path.join(' > '),
                    depth: path.length,
                    name: name
                };
            }
        }

        return { fullPath: name, depth: 1, name };
    }

    /**
     * 获取元素的缩进值（padding-left + margin-left）
     */
    function getElementIndent(el) {
        if (!el) return 0;
        const style = window.getComputedStyle(el);
        const pl = parseFloat(style.paddingLeft) || 0;
        const ml = parseFloat(style.marginLeft) || 0;
        return pl + ml;
    }

    /**
     * 获取容器内所有「行」级元素
     */
    function getAllRows(container) {
        const rows = [];
        // 策略：找所有可能包含类目名和 checkbox 的行
        const candidates = container.children;
        for (const child of candidates) {
            const rect = child.getBoundingClientRect();
            const text = child.textContent.trim();
            // 过滤：可见、有文本内容、不是纯按钮区域
            if (rect.height > 15 && rect.height < 100 && text.length > 1 && text.length < 300) {
                // 排除按钮栏（含「应用」「清除」等）
                if (/(应用|清除|Применить|Очистить|Apply|Clear|选择|Выбрать)/i.test(text) && rect.height < 50) continue;
                rows.push(child);
            }
        }
        // 如果子元素不够，尝试孙元素（有时行嵌套一层）
        if (rows.length < 3) {
            for (const child of candidates) {
                for (const grandchild of child.children) {
                    const rect = grandchild.getBoundingClientRect();
                    const text = grandchild.textContent.trim();
                    if (rect.height > 15 && rect.height < 100 && text.length > 1 && text.length < 300) {
                        if (/(应用|清除|Применить|Очистить|Apply|Clear)/i.test(text) && rect.height < 50) continue;
                        rows.push(grandchild);
                    }
                }
            }
        }
        return rows;
    }

    /**
     * 从单个节点提取类目名称文本
     * 策略：优先找最短的有意义文本（类目名通常就是一行文本）
     */
    function extractNodeName(node) {
        if (!node) return '';

        // 策略1：找直接包含文本的叶子 span（排除含子元素的）
        const spans = node.querySelectorAll('span, div, p, label, a');
        const leafTexts = [];

        for (const el of spans) {
            // 叶子条件：没有含文本的子元素
            const hasTextChild = Array.from(el.children).some(c => {
                const t = c.textContent.trim();
                return t.length > 0 && c.getBoundingClientRect().height > 0;
            });
            if (hasTextChild) continue;

            const directText = Array.from(el.childNodes)
                .filter(n => n.nodeType === 3)
                .map(n => n.textContent.trim())
                .filter(t => t.length > 0)
                .join(' ')
                .trim();

            // 也尝试 el.textContent（有些情况下文本在 innerHTML 赋值中）
            const fullText = el.textContent.trim();

            const text = directText || fullText;

            if (text.length > 0 && text.length < 150 &&
                /[\u4e00-\u9fa5a-zA-Zа-яА-ЯЁё]/.test(text) &&
                !/^\d+$/.test(text)) {
                const rect = el.getBoundingClientRect();
                leafTexts.push({ text, width: rect.width, height: rect.height });
            }
        }

        if (leafTexts.length > 0) {
            // 优先取可见且宽度适中的（类目名通常是最主要的文本块）
            const visible = leafTexts.filter(t => t.width > 20 && t.height > 0);
            if (visible.length > 0) {
                // 按宽度排序取最宽的（类目名通常占最多空间）
                visible.sort((a, b) => b.width - a.width);
                return visible[0].text.split('\n')[0].trim();
            }
            return leafTexts[0].text.split('\n')[0].trim();
        }

        // 策略2：排除 checkbox SVG 和按钮文字后的纯文本
        const allText = node.textContent.trim();
        const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        // 过滤掉太短的（可能是图标 aria-label）和太长的（包含子元素）
        for (const line of lines) {
            if (line.length > 1 && line.length < 100 &&
                /[\u4e00-\u9fa5a-zA-Zа-яА-ЯЁё]/.test(line) &&
                !/^\d+$/.test(line)) {
                return line;
            }
        }

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

    // ==================== UI 面板（FAB + 展开式悬浮窗） ====================

    function updateStatus(text) {
        const el = document.getElementById('ozon-collector-status');
        if (el) el.textContent = text;
        // 同步更新 FAB 徽标
        const badge = document.getElementById('ozon-fab-badge');
        if (badge) {
            const match = text.match(/(\d+)\s*条/);
            badge.textContent = match ? match[1] : '';
            badge.style.display = match ? 'flex' : 'none';
        }
    }

    function initUI() {
        if (document.getElementById('ozon-fab-root')) return;

        // ── 注入样式 ──
        const style = document.createElement('style');
        style.textContent = `
            /* ===== FAB 悬浮按钮 ===== */
            #ozon-fab-root {
                position: fixed;
                bottom: 32px;
                right: 32px;
                z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
            }

            #ozon-fab {
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #005bff 0%, #003d99 100%);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 16px rgba(0,91,255,0.4), 0 2px 4px rgba(0,0,0,0.12);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                outline: none;
                color: #fff;
            }
            #ozon-fab:hover {
                transform: scale(1.08);
                box-shadow: 0 6px 24px rgba(0,91,255,0.5), 0 3px 6px rgba(0,0,0,0.15);
            }
            #ozon-fab:active {
                transform: scale(0.95);
            }
            #ozon-fab.open {
                border-radius: 16px;
                width: 44px;
                height: 44px;
                background: linear-gradient(135deg, #e8eaed 0%, #dadce0 100%);
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            }
            #ozon-fab svg {
                width: 26px;
                height: 26px;
                transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            #ozon-fab.open svg {
                transform: rotate(90deg);
                width: 20px;
                height: 20px;
                color: #5f6368;
            }

            /* FAB 脉冲动效 */
            #ozon-fab::before {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: rgba(0, 91, 255, 0.3);
                animation: ozon-fab-pulse 2.5s ease-in-out infinite;
                z-index: -1;
            }
            #ozon-fab.open::before {
                animation: none;
                opacity: 0;
            }
            @keyframes ozon-fab-pulse {
                0%, 100% { transform: scale(1); opacity: 0.4; }
                50% { transform: scale(1.6); opacity: 0; }
            }

            /* FAB 徽标（显示采集数量） */
            #ozon-fab-badge {
                position: absolute;
                top: -4px;
                right: -4px;
                min-width: 20px;
                height: 20px;
                padding: 0 6px;
                border-radius: 10px;
                background: #e37400;
                color: #fff;
                font-size: 11px;
                font-weight: 600;
                display: none;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 4px rgba(227,116,0,0.3);
                line-height: 1;
            }

            /* FAB 工具提示 */
            #ozon-fab-tip {
                position: absolute;
                right: 68px;
                top: 50%;
                transform: translateY(-50%);
                background: #323232;
                color: #fff;
                font-size: 13px;
                padding: 6px 12px;
                border-radius: 6px;
                white-space: nowrap;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.2s ease;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            #ozon-fab-tip::after {
                content: '';
                position: absolute;
                right: -6px;
                top: 50%;
                transform: translateY(-50%) rotate(45deg);
                width: 10px;
                height: 10px;
                background: #323232;
            }
            #ozon-fab:hover #ozon-fab-tip {
                opacity: 1;
            }

            /* ===== 展开式面板 ===== */
            #ozon-panel {
                position: fixed;
                bottom: 100px;
                right: 32px;
                width: 480px;
                max-height: 560px;
                background: #ffffff;
                border-radius: 16px;
                box-shadow: 0 12px 48px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.08);
                font-size: 13px;
                color: #333;
                z-index: 2147483646;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                line-height: 1.5;
                transform-origin: bottom right;
                transform: scale(0.4) translateY(20px);
                opacity: 0;
                pointer-events: none;
                transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
            }
            #ozon-panel.visible {
                transform: scale(1) translateY(0);
                opacity: 1;
                pointer-events: auto;
            }

            /* 面板头部 */
            #ozon-panel-header {
                background: linear-gradient(135deg, #005bff 0%, #003d99 100%);
                color: #fff;
                padding: 14px 18px;
                font-weight: 600;
                font-size: 15px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
                user-select: none;
                flex-shrink: 0;
                letter-spacing: 0.3px;
            }
            #ozon-panel-header .ozon-header-title {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #ozon-panel-header .ozon-header-actions {
                display: flex;
                gap: 6px;
                align-items: center;
            }
            #ozon-panel-header button {
                background: rgba(255,255,255,0.15);
                border: none;
                color: #fff;
                font-size: 15px;
                cursor: pointer;
                width: 28px;
                height: 28px;
                line-height: 28px;
                text-align: center;
                border-radius: 8px;
                padding: 0;
                transition: background 0.15s;
            }
            #ozon-panel-header button:hover {
                background: rgba(255,255,255,0.3);
            }

            /* 面板主体 */
            #ozon-panel-body {
                padding: 16px 18px 18px;
                overflow-y: auto;
                flex: 1;
                min-height: 0;
            }

            /* 步骤指引 */
            #ozon-steps {
                display: flex;
                gap: 6px;
                margin-bottom: 14px;
                padding: 10px 12px;
                background: linear-gradient(135deg, #f0f6ff 0%, #e8f0fe 100%);
                border-radius: 10px;
                border: 1px solid #d2e3fc;
            }
            .ozon-step {
                flex: 1;
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                color: #1967d2;
                font-weight: 500;
            }
            .ozon-step-num {
                width: 22px;
                height: 22px;
                border-radius: 50%;
                background: #1967d2;
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 700;
                flex-shrink: 0;
            }
            .ozon-step-arrow {
                color: #a8c7fa;
                font-size: 14px;
                flex-shrink: 0;
            }

            /* 操作按钮 */
            #ozon-panel-buttons {
                display: flex;
                gap: 10px;
                margin-bottom: 14px;
            }
            #ozon-panel-buttons button {
                flex: 1;
                padding: 10px 8px;
                border: none;
                border-radius: 10px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }
            #ozon-panel-buttons button:active {
                transform: scale(0.97);
            }
            #ozon-btn-expand {
                background: linear-gradient(135deg, #e8f0fe 0%, #d2e3fc 100%);
                color: #1967d2;
                border: 1px solid #a8c7fa !important;
            }
            #ozon-btn-expand:hover {
                background: linear-gradient(135deg, #d2e3fc 0%, #aecbfa 100%);
                box-shadow: 0 2px 8px rgba(25,103,210,0.15);
            }
            #ozon-btn-collect {
                background: linear-gradient(135deg, #e6f4ea 0%, #ceead6 100%);
                color: #1e8e3e;
                border: 1px solid #a8dab5 !important;
            }
            #ozon-btn-collect:hover {
                background: linear-gradient(135deg, #ceead6 0%, #b7e1c7 100%);
                box-shadow: 0 2px 8px rgba(30,142,62,0.15);
            }
            #ozon-btn-download {
                background: linear-gradient(135deg, #fef3e8 0%, #fce8cc 100%);
                color: #e37400;
                border: 1px solid #f5c88a !important;
            }
            #ozon-btn-download:hover {
                background: linear-gradient(135deg, #fce8cc 0%, #fad9a8 100%);
                box-shadow: 0 2px 8px rgba(227,116,0,0.15);
            }

            /* 选项栏 */
            #ozon-panel-options {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 10px;
                padding: 6px 0;
                border-top: 1px solid #f1f3f4;
                border-bottom: 1px solid #f1f3f4;
            }
            #ozon-panel-options label {
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 5px;
                font-size: 12px;
                color: #666;
            }
            #ozon-panel-options input[type="checkbox"] {
                cursor: pointer;
                accent-color: #005bff;
            }
            #ozon-btn-detect {
                padding: 4px 12px;
                font-size: 11px;
                border: 1px solid #dadce0;
                border-radius: 6px;
                background: #f8f9fa;
                cursor: pointer;
                color: #5f6368;
                transition: all 0.15s;
            }
            #ozon-btn-detect:hover {
                background: #e8eaed;
                border-color: #dadce0;
            }

            /* 状态栏 */
            #ozon-collector-status {
                font-size: 12px;
                color: #5f6368;
                margin-bottom: 12px;
                padding: 8px 12px;
                background: #f8f9fa;
                border-radius: 8px;
                border-left: 3px solid #005bff;
                transition: border-left-color 0.3s;
            }
            #ozon-collector-status.status-ok {
                border-left-color: #34a853;
                background: #f0faf0;
                color: #1e8e3e;
            }
            #ozon-collector-status.status-warn {
                border-left-color: #e37400;
                background: #fef8f0;
                color: #e37400;
            }

            /* 结果表格 */
            #ozon-collector-results {
                max-height: 240px;
                overflow-y: auto;
                border: 1px solid #e8eaed;
                border-radius: 10px;
                background: #fafbfc;
            }
            #ozon-collector-results table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
            }
            #ozon-collector-results th,
            #ozon-collector-results td {
                padding: 8px 10px;
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
                z-index: 1;
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
                max-width: 280px;
            }

            /* 结果计数 */
            #ozon-result-bar {
                margin-top: 10px;
                font-size: 11px;
                color: #999;
                text-align: center;
            }
        `;

        document.head.appendChild(style);

        // ── 创建 FAB + 面板 DOM ──
        const root = document.createElement('div');
        root.id = 'ozon-fab-root';
        root.innerHTML = `
            <!-- FAB 按钮 -->
            <button id="ozon-fab" title="Ozon 类目采集器">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16M4 12h16M4 17h10"/>
                </svg>
                <span id="ozon-fab-badge"></span>
                <span id="ozon-fab-tip">类目采集器</span>
            </button>

            <!-- 展开面板 -->
            <div id="ozon-panel">
                <div id="ozon-panel-header">
                    <div class="ozon-header-title">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span>Ozon 类目采集器</span>
                    </div>
                    <div class="ozon-header-actions">
                        <button id="ozon-btn-collapse" title="收起面板">▾</button>
                    </div>
                </div>
                <div id="ozon-panel-body">
                    <div id="ozon-steps">
                        <div class="ozon-step"><span class="ozon-step-num">1</span>展开全部</div>
                        <span class="ozon-step-arrow">›</span>
                        <div class="ozon-step"><span class="ozon-step-num">2</span>勾选类目</div>
                        <span class="ozon-step-arrow">›</span>
                        <div class="ozon-step"><span class="ozon-step-num">3</span>采集导出</div>
                    </div>
                    <div id="ozon-panel-buttons">
                        <button id="ozon-btn-expand" title="递归展开所有类目节点">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                            展开全部
                        </button>
                        <button id="ozon-btn-collect" title="采集当前勾选的类目">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                            采集选中
                        </button>
                        <button id="ozon-btn-download" title="导出为 CSV 表格">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                            下载 CSV
                        </button>
                    </div>
                    <div id="ozon-panel-options">
                        <label title="控制台输出详细匹配日志，用于排查问题">
                            <input type="checkbox" id="ozon-debug-toggle"> 调试模式
                        </label>
                        <button id="ozon-btn-detect">检测树</button>
                    </div>
                    <div id="ozon-collector-status">就绪 — 请先打开「类目」筛选弹窗</div>
                    <div id="ozon-collector-results">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width:30px;text-align:center;">#</th>
                                    <th>完整路径</th>
                                    <th style="width:50px;text-align:center;">深度</th>
                                    <th style="width:50px;text-align:center;">叶子</th>
                                </tr>
                            </thead>
                            <tbody id="ozon-collector-tbody">
                                <tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">暂无数据</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div id="ozon-result-bar">共 <span id="ozon-result-count">0</span> 条</div>
                </div>
            </div>
        `;

        document.body.appendChild(root);

        // ── 元素引用 ──
        const fab = document.getElementById('ozon-fab');
        const panel = document.getElementById('ozon-panel');
        let panelOpen = false;

        // ── FAB 点击展开/收起 ──
        fab.addEventListener('click', () => {
            panelOpen = !panelOpen;
            panel.classList.toggle('visible', panelOpen);
            fab.classList.toggle('open', panelOpen);
            // 更新图标：展开时显示关闭 X
            fab.innerHTML = panelOpen
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                   <span id="ozon-fab-badge"></span>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
                   <span id="ozon-fab-badge"></span>
                   <span id="ozon-fab-tip">类目采集器</span>`;
            updateStatus(document.getElementById('ozon-collector-status')?.textContent || '');
        });

        // 面板内收起按钮
        document.getElementById('ozon-btn-collapse').onclick = () => {
            panelOpen = false;
            panel.classList.remove('visible');
            fab.classList.remove('open');
            fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
               <span id="ozon-fab-badge"></span>
               <span id="ozon-fab-tip">类目采集器</span>`;
        };

        // ── 操作按钮事件 ──
        document.getElementById('ozon-btn-expand').onclick = expandAll;
        document.getElementById('ozon-btn-collect').onclick = collectSelected;
        document.getElementById('ozon-btn-download').onclick = downloadCSV;
        document.getElementById('ozon-debug-toggle').onchange = (e) => {
            CONFIG.debug = e.target.checked;
            log('调试模式:', CONFIG.debug ? '已开启' : '已关闭');
        };
        document.getElementById('ozon-btn-detect').onclick = () => {
            const c = findTreeContainer();
            const status = document.getElementById('ozon-collector-status');
            if (c) {
                status.textContent = '已检测到类目树 ✓';
                status.className = 'status-ok';
                log('手动检测成功:', c);
            } else {
                status.textContent = '未检测到类目树 ✗ — 请确保弹窗已打开';
                status.className = 'status-warn';
                log('手动检测失败');
            }
        };

        // ── 面板拖拽 ──
        let dragging = false, offset = { x: 0, y: 0 };
        const header = document.getElementById('ozon-panel-header');

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
                status.textContent = '就绪 — 已检测到类目树 ✓';
                status.className = 'status-ok';
            }
        }, 1500);

        log('Ozon 类目采集器已加载 v1.2 (FAB 悬浮窗 + Ozon 自定义 checkbox 支持)');
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
