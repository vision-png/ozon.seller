// ==UserScript==
// @name         Ozon 类目批量采集器
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  手动点击采集 Ozon 卖家后台类目树。点击类目行即可记录/取消，表格按一级/二级/三级类目分列显示，支持导出 CSV 和 Markdown。v4.0 重写核心提取逻辑，更准确识别类目名称。
// @author       You
// @match        https://seller.ozon.ru/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/vision-png/ozon.seller/main/ozon-category-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/vision-png/ozon.seller/main/ozon-category-collector.user.js
// @supportURL   https://github.com/vision-png/ozon.seller/issues
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        debug: false,
        clickReadDelay: 80,
    };

    // ==================== 状态 ====================
    let collectedData = [];       // [{path, l1, l2, l3, name, depth}]
    let trackedElements = new Map(); // element -> {path, l1, l2, l3, name, depth}
    let clickTrackerActive = false;
    let treeContainerRef = null;
    let autoDetectTimer = null;

    // ==================== 黑名单（过滤非类目文本）====================
    const BLACKLIST = new Set([
        '添加商品', '应用', '清除', '按类目搜索',
        'Применить', 'Очистить', 'Найти', 'Категории',
        '选择', '取消', '搜索', '添加', '收起', '展开',
        'Apply', 'Clear', 'Search', 'Cancel', 'Select',
        'Сохранить', 'Закрыть', 'Добавить', 'Сбросить',
    ]);

    function isBlacklisted(text) {
        if (!text) return true;
        const t = text.trim();
        if (t.length < 2 || t.length > 80) return true;
        if (/^\d+$/.test(t)) return true;
        if (BLACKLIST.has(t)) return true;
        // 匹配 "类目: 1" / "Category: 1" 等
        if (/^(类目|Category|Категория)\s*[:：]\s*\d+$/.test(t)) return true;
        // 匹配纯符号
        if (!/[\u4e00-\u9fa5a-zA-Zа-яА-ЯЁё0-9]/.test(t)) return true;
        return false;
    }

    // ==================== 工具函数 ====================
    function log(...args) {
        console.log('%c[Ozon类目采集]', 'color:#005bff;font-weight:bold;', ...args);
    }
    function debug(...args) {
        if (CONFIG.debug) console.log('%c[OzonDebug]', 'color:#f57c00;', ...args);
    }
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    // ==================== DOM 诊断（调试模式）====================
    function diagnoseElement(el) {
        console.group('%c[DOM 诊断]', 'color:#e37400;font-weight:bold;');
        console.log('tagName:', el.tagName);
        console.log('className:', el.className);
        console.log('id:', el.id);
        console.log('data-testid:', el.getAttribute('data-testid'));
        console.log('textContent:', el.textContent.trim().substring(0, 100));
        console.log('children:', Array.from(el.children).map(c =>
            `${c.tagName}${c.className ? '.' + c.className.split(' ').slice(0,2).join('.') : ''}`
        ).join(', '));

        // 输出所有直接子元素的文本
        console.log('直接子元素文本:');
        Array.from(el.children).forEach((child, i) => {
            const text = child.textContent.trim();
            const rect = child.getBoundingClientRect();
            console.log(`  [${i}] ${child.tagName} | w:${Math.round(rect.width)} h:${Math.round(rect.height)} | "${text.substring(0, 60)}"`);
        });

        // 输出内部所有 span/label/div 的文本（叶子节点）
        console.log('候选文本元素:');
        const leaves = [];
        el.querySelectorAll('span, label, div, p, a').forEach(sub => {
            if (sub.querySelector('svg, button, input, [role="checkbox"], [aria-checked]')) return;
            const text = sub.textContent.trim();
            if (isBlacklisted(text)) return;
            const rect = sub.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 8) return;
            leaves.push({ text, width: rect.width, tag: sub.tagName });
        });
        leaves.sort((a, b) => b.width - a.width);
        leaves.slice(0, 5).forEach((l, i) => {
            console.log(`  [${i}] ${l.tag} w:${Math.round(l.width)} | "${l.text.substring(0, 60)}"`);
        });

        console.log('innerHTML (前500字符):', el.innerHTML.substring(0, 500));
        console.groupEnd();
    }

    // ==================== DOM 查找 ====================

    function findTreeContainer() {
        // 语义选择器
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
            if (el) { debug('✓ 树容器 (语义):', sel); return el; }
        }

        // 评分策略
        const candidates = document.querySelectorAll('div, ul, ol');
        let best = null, bestScore = 0;

        candidates.forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 150) return;

            let score = 0;
            score += el.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length * 5;
            score += el.querySelectorAll('[aria-checked], [aria-expanded]').length * 4;
            score += el.querySelectorAll('svg').length * 0.5;

            const text = el.textContent || '';
            if (/Применить|Очистить|应用|清除|Apply|Clear/i.test(text)) score += 10;
            if (/Категории|Категория|类目|Category/i.test(text)) score += 8;

            // 统计有文本的叶子节点
            let textCount = 0;
            el.querySelectorAll('span, div').forEach(n => {
                const t = n.childNodes[0];
                if (t && t.nodeType === 3 && t.textContent.trim().length > 1) textCount++;
            });
            score += textCount * 0.3;

            let depth = 0, p = el;
            while (p) { depth++; p = p.parentElement; }
            score -= depth * 0.2;

            if (score > bestScore && score > 10) {
                bestScore = score;
                best = el;
            }
        });

        if (best) { debug('✓ 树容器 (评分):', bestScore.toFixed(1)); return best; }

        // Ozon 面板特征
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
            const text = div.textContent.trim();
            if (/Применить|Очистить|应用|清除|Apply|Clear/i.test(text)) {
                const rect = div.getBoundingClientRect();
                if (rect.width > 200 && rect.height > 150) {
                    if (div.querySelectorAll('svg').length > 3) {
                        debug('✓ 树容器 (Ozon 面板)');
                        return div;
                    }
                }
            }
        }

        // 弹窗/下拉
        const overlays = document.querySelectorAll([
            '[class*="modal" i] [class*="content" i]:not([class*="modal-overlay" i])',
            '[class*="dropdown" i] [class*="menu" i]',
            '[class*="popover" i] [class*="content" i]',
            '[class*="popup" i]',
        ].join(','));
        for (const ov of overlays) {
            const rect = ov.getBoundingClientRect();
            if (rect.width > 150 && rect.height > 200 && ov.querySelectorAll('div').length > 10) {
                debug('✓ 树容器 (弹窗)');
                return ov;
            }
        }

        debug('✗ 未找到树容器');
        return null;
    }

    // ==================== 类目名称提取（核心）====================

    function extractCategoryName(row) {
        if (!row) return '';

        // 策略1：找行内不包含交互元素的叶子文本元素，选最宽的
        const candidates = [];
        const textEls = row.querySelectorAll('span, label, div, p, a');

        for (const el of textEls) {
            // 排除包含 SVG / button / input / checkbox 的元素
            if (el.querySelector('svg, button, input, [role="checkbox"], [aria-checked]')) continue;

            const text = el.textContent.trim();
            if (isBlacklisted(text)) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width < 30 || rect.height < 8) continue;

            // 必须是叶子节点或接近叶子（不包含 div/span 子元素，或子元素很少）
            const meaningfulChildren = Array.from(el.children).filter(c => {
                const tag = c.tagName.toLowerCase();
                return !['br', 'b', 'i', 'strong', 'em', 'span', 'small'].includes(tag);
            });
            if (meaningfulChildren.length > 0) continue;

            candidates.push({ text, width: rect.width, el });
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => b.width - a.width);
            for (const c of candidates) {
                if (!isBlacklisted(c.text)) {
                    return c.text.split('\n')[0].trim();
                }
            }
        }

        // 策略2：退回到整行 textContent 分析
        const allText = row.textContent.trim();
        const lines = allText.split('\n')
            .map(l => l.trim())
            .filter(l => l.length >= 2 && l.length <= 80 && !isBlacklisted(l));
        if (lines.length > 0) {
            lines.sort((a, b) => b.length - a.length);
            return lines[0];
        }

        return '';
    }

    // ==================== 行检测（核心改进）====================

    function findCategoryRow(target, container) {
        let el = target;
        for (let i = 0; i < 12; i++) {
            if (!el || el === container || el === document.body) return null;

            const rect = el.getBoundingClientRect();
            if (rect.height < 20 || rect.height > 80 || rect.width < 80) {
                el = el.parentElement;
                continue;
            }

            // 检查是否是树行：包含展开指示器或复选框
            const hasIndicator = el.querySelector('svg, [class*="arrow" i], [class*="chevron" i], [aria-expanded], [class*="expand" i], [class*="toggle" i]');
            const hasCheckbox = el.querySelector('[role="checkbox"], input[type="checkbox"], [aria-checked]');
            const isTreeRow = hasIndicator || hasCheckbox;

            if (!isTreeRow) {
                el = el.parentElement;
                continue;
            }

            const name = extractCategoryName(el);
            if (name) {
                if (CONFIG.debug) diagnoseElement(el);
                return el;
            }

            el = el.parentElement;
        }
        return null;
    }

    // ==================== 缩进检测 ====================

    function getIndent(el) {
        if (!el) return 0;
        const s = window.getComputedStyle(el);
        let indent = (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.marginLeft) || 0);

        // 策略2：第一个可见子元素的左偏移
        if (indent === 0) {
            for (const child of el.children) {
                const cRect = child.getBoundingClientRect();
                if (cRect.width > 0 && cRect.height > 0) {
                    const elRect = el.getBoundingClientRect();
                    indent = cRect.left - elRect.left;
                    break;
                }
            }
        }

        // 策略3：所有可见子元素的最小左偏移
        if (indent === 0) {
            let minOffset = Infinity;
            const elRect = el.getBoundingClientRect();
            el.querySelectorAll('*').forEach(child => {
                const cRect = child.getBoundingClientRect();
                if (cRect.width > 0 && cRect.height > 0) {
                    const offset = cRect.left - elRect.left;
                    if (offset < minOffset) minOffset = offset;
                }
            });
            if (minOffset !== Infinity && minOffset > 0) indent = minOffset;
        }

        return indent;
    }

    // ==================== 获取所有可见行 ====================

    function getAllVisibleRows(container) {
        const rows = [];
        const candidates = container.querySelectorAll('div, li');

        for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            const text = el.textContent.trim();

            if (rect.height < 20 || rect.height > 80) continue;
            if (text.length < 2 || text.length > 200) continue;

            // 必须有展开指示器或复选框
            const hasIndicator = el.querySelector('svg, [class*="arrow" i], [class*="chevron" i], [aria-expanded]');
            const hasCheckbox = el.querySelector('[role="checkbox"], input[type="checkbox"], [aria-checked]');
            if (!hasIndicator && !hasCheckbox) continue;

            const name = extractCategoryName(el);
            if (!name) continue;

            // 过滤嵌套
            const isContained = rows.some(r => r !== el && r.contains(el));
            if (!isContained) rows.push(el);
        }

        // 按垂直位置排序
        rows.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return ra.top - rb.top;
        });

        debug('getAllVisibleRows:', rows.length, '行');
        return rows;
    }

    // ==================== 路径构建 ====================

    function buildRowPath(targetRow, allRows) {
        const name = extractCategoryName(targetRow);
        if (!name) return null;

        const targetIndent = getIndent(targetRow);
        const stack = [];

        for (const row of allRows) {
            const indent = getIndent(row);
            const rName = extractCategoryName(row);
            if (!rName) continue;

            while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
                stack.pop();
            }
            stack.push({ indent, name: rName });

            if (row === targetRow) {
                const pathParts = stack.map(s => s.name).filter(Boolean);
                return {
                    path: pathParts.join(' > '),
                    l1: pathParts[0] || '',
                    l2: pathParts[1] || '',
                    l3: pathParts[2] || '',
                    name: rName,
                    depth: pathParts.length
                };
            }
        }

        return { path: name, l1: name, l2: '', l3: '', name, depth: 1 };
    }

    // ==================== 点击处理 ====================

    function onTreeClick(e) {
        if (e.target.closest('#ozon-fab-root')) return;

        const container = treeContainerRef || findTreeContainer();
        if (!container || !container.contains(e.target)) return;

        const row = findCategoryRow(e.target, container);
        if (!row) {
            debug('点击未识别为类目行:', e.target.tagName, e.target.className?.substring(0, 50));
            return;
        }

        const allRows = getAllVisibleRows(container);
        const info = buildRowPath(row, allRows);
        if (!info) {
            debug('无法构建路径');
            return;
        }

        // 切换追踪状态
        if (trackedElements.has(row)) {
            trackedElements.delete(row);
            collectedData = collectedData.filter(d => d.path !== info.path);
            debug('取消追踪:', info.name);
            flashRow(row, 'remove');
        } else {
            const exists = collectedData.some(d => d.path === info.path);
            if (!exists) {
                trackedElements.set(row, info);
                collectedData.push(info);
                debug('追踪:', info.name, '→', info.path);
                flashRow(row, 'add');
            }
        }

        updateStatus(`已追踪 ${collectedData.length} 条类目`);
        renderResults();
    }

    function flashRow(rowEl, action) {
        if (!rowEl) return;
        const color = action === 'add' ? '#34a853' : '#d93025';
        rowEl.style.transition = 'box-shadow 0.3s';
        rowEl.style.boxShadow = `inset 0 0 0 2px ${color}`;
        setTimeout(() => {
            rowEl.style.boxShadow = '';
        }, 600);
    }

    // ==================== 数据采集 ====================

    function clearAll() {
        collectedData = [];
        trackedElements.clear();
        renderResults();
        updateStatus('已清空');
    }

    // ==================== 结果渲染 ====================

    function renderResults() {
        const tbody = document.getElementById('ozon-collector-tbody');
        if (!tbody) return;

        document.getElementById('ozon-result-count').textContent = collectedData.length;

        if (collectedData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无数据 — 在左侧类目树中点击即可采集</td></tr>';
            return;
        }

        tbody.innerHTML = collectedData.map((item, i) => `
            <tr>
                <td style="text-align:center;color:#999;">${i + 1}</td>
                <td>${escapeHtml(item.l1)}</td>
                <td>${escapeHtml(item.l2)}</td>
                <td>${escapeHtml(item.l3)}</td>
                <td>${escapeHtml(item.name)}</td>
                <td style="text-align:center;">
                    <button class="ozon-remove-btn" data-idx="${i}" title="移除此条" style="background:none;border:1px solid #dadce0;border-radius:4px;padding:2px 8px;cursor:pointer;color:#5f6368;font-size:11px;">✕</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.ozon-remove-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                const removed = collectedData.splice(idx, 1)[0];
                for (const [el, info] of trackedElements) {
                    if (info.path === removed.path) trackedElements.delete(el);
                }
                renderResults();
                updateStatus(`已追踪 ${collectedData.length} 条类目`);
            };
        });
    }

    // ==================== 导出 ====================

    function downloadCSV() {
        if (collectedData.length === 0) {
            alert('没有数据！请先点击类目树采集。');
            return;
        }

        const headers = ['一级类目', '二级类目', '三级类目', '类目名称'];
        const rows = collectedData.map(d => [d.l1, d.l2, d.l3, d.name]);

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

        updateStatus(`CSV 已下载 ✓ ${collectedData.length} 条`);
    }

    function downloadMD() {
        if (collectedData.length === 0) {
            alert('没有数据！请先点击类目树采集。');
            return;
        }

        const lines = [
            '# Ozon 类目采集结果',
            '',
            `> 采集时间：${new Date().toLocaleString('zh-CN')}`,
            `> 共 ${collectedData.length} 条`,
            '',
            '| 序号 | 一级类目 | 二级类目 | 三级类目 | 类目名称 |',
            '|------|----------|----------|----------|----------|'
        ];

        collectedData.forEach((d, i) => {
            const l1 = d.l1 || '-';
            const l2 = d.l2 || '-';
            const l3 = d.l3 || '-';
            const name = d.name || '-';
            lines.push(`| ${i + 1} | ${l1} | ${l2} | ${l3} | ${name} |`);
        });

        lines.push('', '---', '*Generated by Ozon Category Collector*');

        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const ts = new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).replace(/[/:]/g, '-').replace(/\s/g, '_');

        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-categories-${ts}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        updateStatus(`Markdown 已下载 ✓ ${collectedData.length} 条`);
    }

    // ==================== 自动检测 ====================

    function refreshTreeContainer() {
        const c = findTreeContainer();
        if (c) {
            treeContainerRef = c;
            debug('容器已刷新');
        }
    }

    // ==================== UI ====================

    function updateStatus(text) {
        const el = document.getElementById('ozon-collector-status');
        if (el) {
            el.textContent = text;
            el.className = text.includes('✓') ? 'status-ok' : text.includes('✗') ? 'status-warn' : '';
        }
        const badge = document.getElementById('ozon-fab-badge');
        if (badge) {
            const match = text.match(/(\d+)\s*条/);
            badge.textContent = match ? match[1] : '';
            badge.style.display = match ? 'flex' : 'none';
        }
    }

    function initUI() {
        if (document.getElementById('ozon-fab-root')) return;

        const style = document.createElement('style');
        style.textContent = `
            /* ===== FAB ===== */
            #ozon-fab-root {
                position: fixed;
                bottom: 32px;
                right: 32px;
                z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
            }
            #ozon-fab {
                width: 56px; height: 56px; border-radius: 50%;
                background: linear-gradient(135deg, #005bff 0%, #003d99 100%);
                border: none; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                box-shadow: 0 4px 16px rgba(0,91,255,0.4), 0 2px 4px rgba(0,0,0,0.12);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative; outline: none; color: #fff;
            }
            #ozon-fab:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(0,91,255,0.5); }
            #ozon-fab:active { transform: scale(0.95); }
            #ozon-fab.open { border-radius: 16px; width: 44px; height: 44px; background: linear-gradient(135deg, #e8eaed 0%, #dadce0 100%); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
            #ozon-fab svg { width: 26px; height: 26px; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
            #ozon-fab.open svg { transform: rotate(90deg); width: 20px; height: 20px; color: #5f6368; }
            #ozon-fab.tracking { background: linear-gradient(135deg, #34a853 0%, #1e8e3e 100%); box-shadow: 0 4px 16px rgba(52,168,83,0.4); }
            #ozon-fab.tracking.open { background: linear-gradient(135deg, #e8eaed 0%, #dadce0 100%); }
            #ozon-fab::before {
                content: ''; position: absolute; width: 100%; height: 100%; border-radius: 50%;
                background: rgba(0,91,255,0.3); animation: ozon-fab-pulse 2.5s ease-in-out infinite; z-index: -1;
            }
            #ozon-fab.tracking::before { background: rgba(52,168,83,0.3); }
            #ozon-fab.open::before { animation: none; opacity: 0; }
            @keyframes ozon-fab-pulse { 0%,100%{transform:scale(1);opacity:0.4;} 50%{transform:scale(1.6);opacity:0;} }
            #ozon-fab-badge {
                position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 6px;
                border-radius: 10px; background: #e37400; color: #fff; font-size: 11px; font-weight: 600;
                display: none; align-items: center; justify-content: center; box-shadow: 0 2px 4px rgba(227,116,0,0.3); line-height: 1;
            }
            #ozon-fab-tip {
                position: absolute; right: 68px; top: 50%; transform: translateY(-50%);
                background: #323232; color: #fff; font-size: 13px; padding: 6px 12px; border-radius: 6px;
                white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            #ozon-fab-tip::after { content:''; position: absolute; right: -6px; top: 50%; transform: translateY(-50%) rotate(45deg); width: 10px; height: 10px; background: #323232; }
            #ozon-fab:hover #ozon-fab-tip { opacity: 1; }

            /* ===== 面板 ===== */
            #ozon-panel {
                position: fixed; bottom: 100px; right: 32px; width: 560px; max-height: 640px;
                background: #fff; border-radius: 16px;
                box-shadow: 0 12px 48px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.08);
                font-size: 13px; color: #333; z-index: 2147483646;
                overflow: hidden; display: flex; flex-direction: column; line-height: 1.5;
                transform-origin: bottom right;
                transform: scale(0.4) translateY(20px); opacity: 0; pointer-events: none;
                transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
            }
            #ozon-panel.visible { transform: scale(1) translateY(0); opacity: 1; pointer-events: auto; }
            #ozon-panel-header {
                background: linear-gradient(135deg, #005bff 0%, #003d99 100%); color: #fff;
                padding: 14px 18px; font-weight: 600; font-size: 15px;
                display: flex; justify-content: space-between; align-items: center;
                cursor: move; user-select: none; flex-shrink: 0; letter-spacing: 0.3px;
            }
            #ozon-panel-header .ozon-header-title { display: flex; align-items: center; gap: 8px; }
            #ozon-panel-header button {
                background: rgba(255,255,255,0.15); border: none; color: #fff; font-size: 15px;
                cursor: pointer; width: 28px; height: 28px; line-height: 28px; text-align: center;
                border-radius: 8px; padding: 0; transition: background 0.15s;
            }
            #ozon-panel-header button:hover { background: rgba(255,255,255,0.3); }
            #ozon-panel-body { padding: 16px 18px 18px; overflow-y: auto; flex: 1; min-height: 0; }

            /* 模式提示 */
            #ozon-mode-hint {
                margin-bottom: 12px; padding: 10px 14px; border-radius: 10px; font-size: 12px;
                background: linear-gradient(135deg, #e6f4ea 0%, #ceead6 100%);
                border: 1px solid #a8dab5; color: #1e8e3e;
                display: flex; align-items: center; gap: 8px;
            }
            #ozon-mode-hint svg { width: 18px; height: 18px; flex-shrink: 0; }

            /* 操作按钮 */
            #ozon-panel-buttons { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
            #ozon-panel-buttons button {
                flex: 1; min-width: 80px; padding: 9px 6px; border: none; border-radius: 10px;
                font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
                display: flex; align-items: center; justify-content: center; gap: 5px;
            }
            #ozon-panel-buttons button:active { transform: scale(0.97); }
            #ozon-panel-buttons button svg { width: 14px; height: 14px; }
            .ozon-btn-blue { background: linear-gradient(135deg, #e8f0fe, #d2e3fc); color: #1967d2; border: 1px solid #a8c7fa !important; }
            .ozon-btn-blue:hover { background: linear-gradient(135deg, #d2e3fc, #aecbfa); }
            .ozon-btn-green { background: linear-gradient(135deg, #e6f4ea, #ceead6); color: #1e8e3e; border: 1px solid #a8dab5 !important; }
            .ozon-btn-green:hover { background: linear-gradient(135deg, #ceead6, #b7e1c7); }
            .ozon-btn-orange { background: linear-gradient(135deg, #fef3e8, #fce8cc); color: #e37400; border: 1px solid #f5c88a !important; }
            .ozon-btn-orange:hover { background: linear-gradient(135deg, #fce8cc, #fad9a8); }
            .ozon-btn-red { background: linear-gradient(135deg, #fce8e6, #f7d7d5); color: #d93025; border: 1px solid #f0b8b5 !important; }
            .ozon-btn-red:hover { background: linear-gradient(135deg, #f7d7d5, #f0b8b5); }
            .ozon-btn-gray { background: #f1f3f4; color: #5f6368; border: 1px solid #dadce0 !important; }
            .ozon-btn-gray:hover { background: #e8eaed; }

            /* 选项栏 */
            #ozon-panel-options {
                display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 10px; padding: 6px 0;
                border-top: 1px solid #f1f3f4; border-bottom: 1px solid #f1f3f4;
            }
            #ozon-panel-options label { cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 12px; color: #666; }
            #ozon-panel-options input[type="checkbox"] { cursor: pointer; accent-color: #005bff; }

            /* 状态栏 */
            #ozon-collector-status {
                font-size: 12px; color: #5f6368; margin-bottom: 12px; padding: 8px 12px;
                background: #f8f9fa; border-radius: 8px; border-left: 3px solid #005bff; transition: all 0.3s;
            }
            #ozon-collector-status.status-ok { border-left-color: #34a853; background: #f0faf0; color: #1e8e3e; }
            #ozon-collector-status.status-warn { border-left-color: #e37400; background: #fef8f0; color: #e37400; }

            /* 结果表格 */
            #ozon-collector-results { max-height: 280px; overflow-y: auto; border: 1px solid #e8eaed; border-radius: 10px; background: #fafbfc; }
            #ozon-collector-results table { width: 100%; border-collapse: collapse; font-size: 12px; }
            #ozon-collector-results th, #ozon-collector-results td { padding: 7px 8px; text-align: left; border-bottom: 1px solid #e8eaed; white-space: nowrap; }
            #ozon-collector-results th { background: #f1f3f4; font-weight: 600; position: sticky; top: 0; color: #5f6368; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; z-index: 1; }
            #ozon-collector-results tr:last-child td { border-bottom: none; }
            #ozon-collector-results tr:hover td { background: #e8f0fe; }
            #ozon-collector-results td:nth-child(2),
            #ozon-collector-results td:nth-child(3),
            #ozon-collector-results td:nth-child(4),
            #ozon-collector-results td:nth-child(5) { white-space: normal; word-break: break-all; max-width: 140px; }
            .ozon-remove-btn { transition: all 0.15s; }
            .ozon-remove-btn:hover { background: #d93025 !important; color: #fff !important; border-color: #d93025 !important; }

            /* 结果计数 */
            #ozon-result-bar { margin-top: 10px; font-size: 11px; color: #999; text-align: center; }
        `;

        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'ozon-fab-root';
        root.innerHTML = `
            <button id="ozon-fab" title="Ozon 类目采集器">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16M4 12h16M4 17h10"/>
                </svg>
                <span id="ozon-fab-badge"></span>
                <span id="ozon-fab-tip">类目采集器</span>
            </button>
            <div id="ozon-panel">
                <div id="ozon-panel-header">
                    <div class="ozon-header-title">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        <span>Ozon 类目采集器 v4.0</span>
                    </div>
                    <button id="ozon-btn-collapse" title="收起">▾</button>
                </div>
                <div id="ozon-panel-body">
                    <!-- 模式提示 -->
                    <div id="ozon-mode-hint">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                        <span>手动追踪模式 — 在左侧类目树中点击任意类目行即可记录/取消</span>
                    </div>

                    <!-- 操作按钮 -->
                    <div id="ozon-panel-buttons">
                        <button id="ozon-btn-download-csv" class="ozon-btn-orange" title="导出 CSV">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                            下载 CSV
                        </button>
                        <button id="ozon-btn-download-md" class="ozon-btn-blue" title="导出 Markdown">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            下载 MD
                        </button>
                        <button id="ozon-btn-clear" class="ozon-btn-red" title="清空所有采集数据">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            清空
                        </button>
                    </div>

                    <!-- 选项 -->
                    <div id="ozon-panel-options">
                        <label title="控制台输出详细日志 + DOM 诊断">
                            <input type="checkbox" id="ozon-debug-toggle"> 调试模式
                        </label>
                        <button id="ozon-btn-detect" class="ozon-btn-gray" style="padding:4px 12px;font-size:11px;border-radius:6px;border:1px solid #dadce0;background:#f8f9fa;cursor:pointer;color:#5f6368;">检测树</button>
                    </div>

                    <div id="ozon-collector-status">就绪 — 请先打开「类目」筛选弹窗</div>
                    <div id="ozon-collector-results">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width:28px;text-align:center;">#</th>
                                    <th style="width:110px;">一级类目</th>
                                    <th style="width:110px;">二级类目</th>
                                    <th style="width:110px;">三级类目</th>
                                    <th style="width:110px;">类目名称</th>
                                    <th style="width:36px;text-align:center;"></th>
                                </tr>
                            </thead>
                            <tbody id="ozon-collector-tbody">
                                <tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无数据 — 在左侧类目树中点击即可采集</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div id="ozon-result-bar">共 <span id="ozon-result-count">0</span> 条</div>
                </div>
            </div>
        `;

        document.body.appendChild(root);

        const fab = document.getElementById('ozon-fab');
        const panel = document.getElementById('ozon-panel');
        let panelOpen = false;

        // FAB 点击
        fab.addEventListener('click', () => {
            panelOpen = !panelOpen;
            panel.classList.toggle('visible', panelOpen);
            fab.classList.toggle('open', panelOpen);
            fab.innerHTML = panelOpen
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg><span id="ozon-fab-badge"></span>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span id="ozon-fab-badge"></span><span id="ozon-fab-tip">类目采集器</span>`;
            updateStatus(document.getElementById('ozon-collector-status')?.textContent || '');
        });

        // 面板内收起
        document.getElementById('ozon-btn-collapse').onclick = () => {
            panelOpen = false;
            panel.classList.remove('visible');
            fab.classList.remove('open');
            fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span id="ozon-fab-badge"></span><span id="ozon-fab-tip">类目采集器</span>`;
        };

        // 操作按钮
        document.getElementById('ozon-btn-download-csv').onclick = downloadCSV;
        document.getElementById('ozon-btn-download-md').onclick = downloadMD;
        document.getElementById('ozon-btn-clear').onclick = clearAll;
        document.getElementById('ozon-debug-toggle').onchange = (e) => {
            CONFIG.debug = e.target.checked;
            log('调试模式:', CONFIG.debug ? '已开启' : '已关闭');
            if (CONFIG.debug) {
                console.log('%c[提示]', 'color:#005bff;font-weight:bold;', '调试模式已开启。点击类目树中的元素时，控制台会输出该元素的 DOM 诊断信息。');
            }
        };
        document.getElementById('ozon-btn-detect').onclick = () => {
            const c = findTreeContainer();
            const status = document.getElementById('ozon-collector-status');
            if (c) {
                status.textContent = '已检测到类目树 ✓';
                status.className = 'status-ok';
                treeContainerRef = c;
                log('手动检测成功');
            } else {
                status.textContent = '未检测到类目树 ✗';
                status.className = 'status-warn';
            }
        };

        // 面板拖拽
        let dragging = false, offset = { x: 0, y: 0 };
        const header = document.getElementById('ozon-panel-header');
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offset.x = e.clientX - rect.left;
            offset.y = e.clientY - rect.top;
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
            panel.style.left = rect.left + 'px'; panel.style.top = rect.top + 'px';
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offset.x) + 'px';
            panel.style.top = (e.clientY - offset.y) + 'px';
        });
        document.addEventListener('mouseup', () => dragging = false);

        // 自动检测类目树
        autoDetectTimer = setInterval(() => {
            const c = findTreeContainer();
            const status = document.getElementById('ozon-collector-status');
            if (c) treeContainerRef = c;
            if (c && status && status.textContent.includes('请先打开')) {
                status.textContent = '就绪 — 已检测到类目树 ✓';
                status.className = 'status-ok';
                if (!clickTrackerActive) {
                    startClickTracker();
                    fab.classList.add('tracking');
                }
            }
        }, 1500);

        // 默认启用点击追踪
        startClickTracker();
        fab.classList.add('tracking');

        log('Ozon 类目采集器 v4.0 已加载（手动追踪 + 分级显示 + MD导出）');
    }

    function startClickTracker() {
        if (clickTrackerActive) return;
        clickTrackerActive = true;
        document.addEventListener('click', onTreeClick, true);
        log('点击追踪已启用');
    }

    function stopClickTracker() {
        clickTrackerActive = false;
        document.removeEventListener('click', onTreeClick, true);
        log('点击追踪已关闭');
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
