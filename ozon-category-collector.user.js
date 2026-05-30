// ==UserScript==
// @name         Ozon 类目批量采集器
// @namespace    http://tampermonkey.net/
// @version      5.5
// @description  基于 Ozon 卖家后台真实 DOM 结构重写的类目采集器。v5.5 点击追踪改用当前DOM快照向上查找父级，避免持久化栈被虚拟滚动片段污染。
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
        // Ozon 特征类名前缀（动态生成的 hash 前缀）
        rowPrefixes: ['c7131', 'cs0131', 'cs2131', 'd19-', 'c6131'],
    };

    // ==================== 状态 ====================
    let collectedData = [];
    let trackedElements = new Map();
    let clickTrackerActive = false;
    let treeContainerRef = null;
    let autoDetectTimer = null;

    // ==================== 黑名单 ====================
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
        if (/^(类目|Category|Категория)\s*[:：]\s*\d+$/.test(t)) return true;
        if (!/[\u4e00-\u9fa5a-zA-Zа-яА-ЯЁё0-9]/.test(t)) return true;
        return false;
    }

    // ==================== 工具函数 ====================
    function log(...args) {
        console.log('%c[Ozon类目]', 'color:#005bff;font-weight:bold;', ...args);
    }
    function debug(...args) {
        if (CONFIG.debug) console.log('%c[Debug]', 'color:#e37400;', ...args);
    }
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    /**
     * 从元素的 style 属性中提取 --level CSS 变量值
     * Ozon 用 style="--level: N; ..." 来标记层级深度
     */
    function getLevelFromStyle(el) {
        if (!el || !el.style) return -1;
        const style = el.getAttribute('style') || '';
        const match = style.match(/--level\s*:\s*(\d+)/i);
        return match ? parseInt(match[1]) : -1;
    }

    // ==================== DOM 查找（基于真实结构）====================

    /**
     * 找到类目树的滚动容器
     * 真实结构：div.cs2131-a2 (overflow scroll)
     * 它包含 ul > li.c7131-a3 (每行)
     */
    function findTreeContainer() {
        // 策略1：直接找 Ozon 特征类名的滚动容器
        for (const prefix of CONFIG.rowPrefixes) {
            // 找带有 overflow scroll 且包含多个 li 行元素的容器
            const els = document.querySelectorAll(`[class*="${prefix}-a2"]`);
            for (const el of els) {
                const style = window.getComputedStyle(el);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                     el.scrollHeight > el.clientHeight) &&
                    el.querySelectorAll('li').length >= 2) {
                    debug('✓ 树容器 (特征类名+滚动):', el.className, `${el.querySelectorAll('li').length} 行`);
                    return el;
                }
            }
        }

        // 策略2：找包含 --level style 的 button 的最近公共滚动祖先
        const levelBtns = document.querySelectorAll('button[style*="--level"]');
        if (levelBtns.length > 0) {
            // 取第一个 button，往上找到滚动容器
            let container = levelBtns[0].parentElement;
            while (container && container !== document.body) {
                const s = window.getComputedStyle(container);
                if (s.overflowY === 'auto' || s.overflowY === 'scroll' ||
                    container.scrollHeight > container.clientHeight) {
                    const liCount = container.querySelectorAll('li').length;
                    if (liCount >= 2) {
                        debug('✓ 树容器 (--level按钮→滚动):', container.className?.substring(0, 40), `${liCount} 行`);
                        return container;
                    }
                }
                container = container.parentElement;
            }
            // 如果没找到独立滚动容器，就用包含所有 levelBtns 的最接近的共同祖先
            let common = levelBtns[0].closest('[class*="a2"]') || levelBtns[0].parentElement?.parentElement?.parentElement;
            if (common && common.querySelectorAll('button[style*="--level"]').length >= 2) {
                debug('✓ 树容器 (--level按钮→共同祖先):', common.className?.substring(0, 40));
                return common;
            }
        }

        // 策略3：找弹窗/下拉面板内最大的列表区域
        const popups = document.querySelectorAll(
            '[class*="popover" i], [class*="popup" i], [class*="dropdown" i] [class*="menu" i], ' +
            '[role="dialog"], [role="listbox"]'
        );
        for (const popup of popups) {
            const btns = popup.querySelectorAll('button[style*="--level"]');
            if (btns.length >= 2) {
                // 找到包含这些按钮的列表容器
                const listContainer = findListContainerForButtons(btns);
                if (listContainer) {
                    debug('✓ 树容器 (弹窗+--level):', listContainer.className?.substring(0, 40), `${btns.length} 行`);
                    return listContainer;
                }
                debug('✓ 树容器 (弹窗本身):', popup.className?.substring(0, 40), `${btns.length} 行`);
                return popup;
            }
        }

        // 策略4：全局搜索带 checkbox 和层级的列表
        const allLi = document.querySelectorAll('li');
        for (const li of allLi.slice(0, 200)) {
            const btn = li.querySelector('button[style*="--level"]');
            if (btn) {
                const parent = li.parentElement;
                if (parent && parent.querySelectorAll('li').length >= 2) {
                    let container = parent.parentElement;
                    // 再往上找一层到滚动容器
                    if (container) {
                        const scroller = container.closest('[class*="-a2"]') || container.parentElement;
                        if (scroller) {
                            debug('✓ 树容器 (li→parent):', scroller.className?.substring(0, 40));
                            return scroller;
                        }
                    }
                    debug('✓ 树容器 (li parent):', parent.className?.substring(0, 40), `${parent.querySelectorAll('li').length} 行`);
                    return parent;
                }
            }
        }

        debug('✗ 未找到树容器');
        return null;
    }

    /** 给定一组 --level buttons，找到它们的列表容器 */
    function findListContainerForButtons(btns) {
        if (!btns || btns.length === 0) return null;
        // 所有 button 共享的最接近的祖先
        let container = btns[0].parentElement;
        while (container) {
            const childBtns = container.querySelectorAll('button[style*="--level"]');
            if (childBtns.length >= btns.length * 0.8) return container;
            container = container.parentElement;
            if (container === document.body) break;
        }
        return btns[0].closest('ul, [role="list"], [class*="list" i]') || btns[0].parentElement;
    }

    // ==================== 行检测与名称提取 ====================

    /**
     * 获取所有类目行
     * 真实结构：li > button[style="--level: N"] > (::before箭头) + div.checkbox + div.content(含名称)
     */
    function getAllCategoryRows(container) {
        const rows = [];
        if (!container) return rows;

        // 方法1：直接找带 --level 的 button，取其最近的 li 祖先
        const allBtns = container.querySelectorAll('button[style*="--level"]');
        const seen = new Set();

        for (const btn of allBtns) {
            // 找到这个 button 所属的行容器（li 或其父级）
            let rowEl = btn.closest('li') || btn.parentElement;

            if (seen.has(rowEl)) continue;
            seen.add(rowEl);

            const level = getLevelFromStyle(btn);
            const name = extractNameFromButton(btn);

            rows.push({
                element: rowEl,
                button: btn,
                level: level,
                name: name,
            });
        }

        // 按 DOM 顺序排序（使用 sourceIndex / compareDocumentPosition）
        rows.sort((a, b) => {
            const pos = a.element.compareDocumentPosition(b.element);
            return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });

        debug(`getAllCategoryRows: ${rows.length} 行`);
        return rows;
    }

    /**
     * 从 button 元素内部提取类目名称
     * 关键发现：Ozon 用 class="table-500" 标记所有层级(L1/L2/L3)的类目文本元素
     * - L1: div.c0s131-a3.c0s131-a5.table-500
     * - L2: label.table-500  +  div.c0s131-a3.c0s131-a5.table-500
     * - L3: div.c0s131-a3.c0s131-a5.table-500
     */
    function extractNameFromButton(btn) {
        if (!btn) return '';

        // 策略1：直接找所有带 table-500 类名的元素（Ozon 标记文本区域的方式）
        const table500Els = btn.querySelectorAll('.table-500');
        const candidates = [];
        for (const el of table500Els) {
            const text = getTextContentClean(el);
            if (text && !isBlacklisted(text)) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 15 && rect.height > 8) {
                    candidates.push({ text, width: rect.width, el });
                }
            }
        }
        if (candidates.length > 0) {
            // 按宽度排序，取最宽的（通常是完整类目名）
            candidates.sort((a, b) => b.width - a.width);
            debug('extractNameFromButton(table-500):', candidates.slice(0, 3).map(c => `"${c.text}" w:${Math.round(c.width)}`));
            return candidates[0].text.split('\n')[0].trim();
        }

        // 策略2：fallback — 递归扫描所有子元素找文本
        const fallbackCandidates = [];
        function scanChildren(el, depth = 0) {
            if (depth > 6) return;
            for (const child of Array.from(el.children)) {
                const tag = child.tagName.toLowerCase();
                const cls = child.className || '';
                if (tag === 'svg' || tag === 'button' || tag === 'input') continue;
                if (cls.includes('checkbox') || cls.includes('check')) continue;
                if (child.getAttribute('role') === 'checkbox') continue;

                const text = getTextContentClean(child);
                if (text && !isBlacklisted(text)) {
                    const rect = child.getBoundingClientRect();
                    if (rect.width > 15 && rect.height > 8) {
                        fallbackCandidates.push({ text, width: rect.width });
                        continue;
                    }
                }
                scanChildren(child, depth + 1);
            }
        }
        scanChildren(btn);
        if (fallbackCandidates.length > 0) {
            fallbackCandidates.sort((a, b) => b.width - a.width);
            return fallbackCandidates[0].text.split('\n')[0].trim();
        }

        // 兜底：取 button 整体 textContent 过滤后最长的一段
        const allText = (btn.textContent || '').trim();
        const lines = allText.split(/\s+/).filter(t => t.length >= 2 && !isBlacklisted(t));
        if (lines.length > 0) {
            lines.sort((a, b) => b.length - a.length);
            return lines[0];
        }
        return '';
    }

    /** 获取元素及其所有后代中的纯文本内容（递归所有元素类型） */
    function getTextContentClean(el) {
        let text = '';
        for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === 3) { // 文本节点
                text += node.textContent.trim() + ' ';
            } else if (node.nodeType === 1) { // 元素节点 — 递归所有类型
                const sub = getTextContentClean(node);
                if (sub) text += sub + ' ';
            }
        }
        return text.trim();
    }

    /**
     * 从点击目标找到对应的类目行
     * 只向上遍历祖先链，检查当前元素本身是否是 --level button
     * 避免 querySelector 跨行匹配到错误的 button
     */
    function findRowFromTarget(target, container) {
        let el = target;
        for (let i = 0; i < 15; i++) {
            if (!el || el === document.body || el === container) break;

            // 当前元素本身就是 --level button
            if (el.tagName === 'BUTTON' && el.getAttribute('style')?.includes('--level')) {
                const row = el.closest('li') || el.parentElement;
                const level = getLevelFromStyle(el);
                const name = extractNameFromButton(el);
                return { element: row, button: el, level, name };
            }

            el = el.parentElement;
        }
        return null;
    }

    // ==================== 路径构建（基于 --level，跨滚动轮次持久化）====================

    /**
     * 持久化路径栈 —— 跨虚拟滚动轮次保持层级上下文
     * 虚拟滚动会卸载已滚出的 DOM 节点（包括父级 L1），
     * 如果每轮从空栈开始构建，L2/L3 就会丢失父级上下文。
     * 此栈在所有操作间共享，确保即使 L1 不在当前视口内也能正确记录。
     */
    let pathStack = []; // [{level: number, name: string}]

    /** 用一行数据更新持久化路径栈 */
    function updatePersistentStack(rowInfo) {
        const { level, name } = rowInfo;
        if (!name || level < 0) return;

        // 弹出 level >= 当前 level 的项（同级的下一个替换，或回退到更上层）
        while (pathStack.length > 0 && pathStack[pathStack.length - 1].level >= level) {
            pathStack.pop();
        }
        pathStack.push({ level, name });
    }

    /** 从持久化栈获取完整路径信息 */
    function getPathFromStack(currentName) {
        const parts = pathStack.map(s => s.name).filter(Boolean);
        return {
            path: parts.join(' > '),
            l1: parts[0] || '',
            l2: parts[1] || '',
            l3: parts[2] || '',
            name: currentName,
            depth: parts.length,
        };
    }

    /** 重置持久化栈（新扫描开始时调用） */
    function resetPathStack() {
        pathStack = [];
    }

    /**
     * 为单行构建路径信息（全量扫描用）
     * 使用持久化栈，跨虚拟滚动轮次保持层级上下文
     */
    function buildPathForRow(targetRowInfo, allRows) {
        const { name, level } = targetRowInfo;
        if (!name) return null;

        for (const rowInfo of allRows) {
            if (rowInfo === targetRowInfo) break;
            if (rowInfo.name && rowInfo.level >= 0) {
                updatePersistentStack(rowInfo);
            }
        }
        updatePersistentStack(targetRowInfo);
        return getPathFromStack(name);
    }

    // ==================== 点击追踪专用路径构建（不依赖持久化状态）====================

    /**
     * 点击追踪专用：基于当前可见DOM快照向上查找父级
     * 不依赖任何全局持久化栈，避免虚拟滚动下不同类目片段互相污染
     */
    function buildPathForClick(rowInfo, allRows) {
        const { level, name, element, button } = rowInfo;
        if (!name || level < 0) return null;

        // level 0 = 一级类目本身
        if (level === 0) {
            return { path: name, l1: name, l2: '', l3: '', name, depth: 1 };
        }

        // 找到当前行在快照中的位置
        const currentIndex = allRows.findIndex(r =>
            r.element === element || r.button === button
        );

        // 向上查找各级父级
        const l1 = findAncestorNameAtLevel(allRows, currentIndex, 0);
        const l2 = level >= 2 ? findAncestorNameAtLevel(allRows, currentIndex, 1) : '';

        const parts = [l1, l2, name].filter(Boolean);
        return {
            path: parts.join(' > '),
            l1: l1 || name,
            l2,
            l3: level >= 2 ? name : '',
            name,
            depth: parts.length,
        };
    }

    /** 在 allRows 快照中从 currentIndex 向上查找指定 level 的最近行名称 */
    function findAncestorNameAtLevel(allRows, currentIndex, targetLevel) {
        if (currentIndex < 0) return '';
        for (let i = currentIndex - 1; i >= 0; i--) {
            if (allRows[i].level === targetLevel && allRows[i].name) {
                return allRows[i].name;
            }
        }
        return '';
    }

    // ==================== 全量扫描（虚拟滚动兼容）====================

    let scanInProgress = false;

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async function scanAllCategories() {
        const container = treeContainerRef || findTreeContainer();
        if (!container) {
            alert('未找到类目树！请先打开「类目」筛选弹窗。');
            return;
        }

        if (scanInProgress) {
            alert('正在扫描中，请稍候...');
            return;
        }

        // 检测是否是虚拟滚动（当前DOM行数远小于容器可显示的行数）
        const visibleRows = container.querySelectorAll('li').length;
        const isVirtual = visibleRows > 0 && visibleRows <= 35 && container.scrollHeight > container.clientHeight * 2;
        debug('扫描模式:', isVirtual ? '虚拟滚动采集' : '一次性采集', `当前DOM行:${visibleRows}`);

        scanInProgress = true;
        clearAll();
        resetPathStack(); // ← 关键：重置持久化栈
        updateStatus('正在扫描...');

        // 用 path 去重
        const seenPaths = new Set();
        let totalCollected = 0;
        let rounds = 0;

        if (isVirtual) {
            // ===== 虚拟滚动：逐步滚动采集 =====
            const scroller = container.scrollTop !== undefined ? container : container.querySelector('[class*="-a2"]') || container;
            const scrollStep = Math.max(200, Math.floor(scroller.clientHeight * 0.6)); // 每次滚 60% 容器高度
            const maxRounds = 200; // 安全上限

            // 先滚到顶部
            scroller.scrollTop = 0;
            await sleep(400);

            let lastScrollTop = -1;
            let stagnantCount = 0;

            while (rounds < maxRounds) {
                rounds++;
                const currentRows = getAllCategoryRows(container);
                let newInRound = 0;

                for (const rowInfo of currentRows) {
                    if (!rowInfo.name || rowInfo.level < 0) continue;
                    // ← 关键：使用持久化栈更新层级上下文，不重置
                    updatePersistentStack(rowInfo);
                    const info = getPathFromStack(rowInfo.name);
                    if (info && !seenPaths.has(info.path)) {
                        seenPaths.add(info.path);
                        collectedData.push(info);
                        newInRound++;
                    }
                }
                totalCollected += newInRound;
                updateStatus(`扫描中... 第 ${rounds} 轮 +${newInRound} 条 (累计 ${totalCollected})`);
                debug(`扫描第 ${rounds} 轮: 当前DOM ${currentRows.length} 行, 新增 ${newInRound}, 累计 ${totalCollected}`);

                // 向下滚动
                const beforeScroll = scroller.scrollTop;
                scroller.scrollTop += scrollStep;
                await sleep(350); // 等待虚拟滚动渲染

                // 检测是否到底（scrollTop 没变或接近底部）
                if (scroller.scrollTop === beforeScroll || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10) {
                    stagnantCount++;
                    if (stagnantCount >= 2) {
                        // 再采一轮底部内容
                        const finalRows = getAllCategoryRows(container);
                        for (const rowInfo of finalRows) {
                            if (!rowInfo.name || rowInfo.level < 0) continue;
                            updatePersistentStack(rowInfo);
                            const info = getPathFromStack(rowInfo.name);
                            if (info && !seenPaths.has(info.path)) {
                                seenPaths.add(info.path);
                                collectedData.push(info);
                                totalCollected++;
                            }
                        }
                        debug('到达底部，扫描结束');
                        break;
                    }
                } else {
                    stagnantCount = 0;
                }

                lastScrollTop = scroller.scrollTop;
            }
        } else {
            // ===== 普通列表：一次性采集 =====
            const rows = getAllCategoryRows(container);
            for (const rowInfo of rows) {
                if (!rowInfo.name || rowInfo.level < 0) continue;
                updatePersistentStack(rowInfo);
                const info = getPathFromStack(rowInfo.name);
                if (info && !seenPaths.has(info.path)) {
                    seenPaths.add(info.path);
                    collectedData.push(info);
                    totalCollected++;
                }
            }
        }

        scanInProgress = false;
        updateStatus(`已扫描 ${totalCollected} 条类目 ✓`);
        renderResults();
        log(`全量扫描完成: ${totalCollected} 条 (共 ${rounds} 轮)`);
    }

    // ==================== 点击追踪处理 ====================

    function onTreeClick(e) {
        // 忽略自身面板内的点击
        if (e.target.closest('#ozon-fab-root')) return;

        const container = treeContainerRef || findTreeContainer();
        if (!container) return;
        if (!container.contains(e.target)) return;

        const found = findRowFromTarget(e.target, container);
        if (!found) {
            debug('点击未匹配类目行:', e.target.tagName, e.target.className?.substring(0, 50));
            return;
        }

        const { element: row, button, level, name } = found;
        if (!name) {
            debug('无法提取类目名称:', button.outerHTML.substring(0, 200));
            return;
        }

        // 点击追踪：基于当前可见DOM快照向上查找父级
        // 不依赖任何全局持久化状态，避免虚拟滚动下不同片段互相污染
        const allRows = getAllCategoryRows(container);
        const currentRowInfo = { element: row, button, level, name };
        const info = buildPathForClick(currentRowInfo, allRows);
        if (!info) return;

        // 用 path 字符串去重/移除（不依赖 element 引用，避免 DOM 变化导致重复）
        const existingIndex = collectedData.findIndex(d => d.path === info.path);
        if (existingIndex >= 0) {
            collectedData.splice(existingIndex, 1);
            flashRow(row, '#d93025');
            debug('取消追踪:', info.name, info.path);
        } else {
            collectedData.push(info);
            flashRow(row, '#34a853');
            debug('追踪:', info.name, '(L' + info.depth + ')', info.path);
        }

        updateStatus(`已追踪 ${collectedData.length} 条类目`);
        renderResults();
    }

    function flashRow(rowEl, color) {
        if (!rowEl) return;
        rowEl.style.transition = 'box-shadow 0.3s';
        rowEl.style.boxShadow = `inset 3px 0 0 ${color}`;
        setTimeout(() => { rowEl.style.boxShadow = ''; }, 500);
    }

    // ==================== 数据操作 ====================

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
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无数据 — 在类目弹窗中点击采集，或使用「全量扫描」</td></tr>';
            return;
        }

        tbody.innerHTML = collectedData.map((item, i) => `
            <tr>
                <td style="text-align:center;color:#999;width:28px;">${i + 1}</td>
                <td>${escapeHtml(item.l1)}</td>
                <td>${escapeHtml(item.l2)}</td>
                <td>${escapeHtml(item.l3)}</td>
                <td><strong>${escapeHtml(item.name)}</strong></td>
                <td style="text-align:center;width:36px;">
                    <button class="ozon-remove-btn" data-idx="${i}" title="移除" style="background:none;border:1px solid #dadce0;border-radius:4px;padding:2px 8px;cursor:pointer;color:#5f6368;font-size:11px;">✕</button>
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
        if (collectedData.length === 0) { alert('没有数据！'); return; }
        const headers = ['一级类目', '二级类目', '三级类目', '类目名称'];
        const rows = collectedData.map(d => [d.l1, d.l2, d.l3, d.name]);
        const csv = [
            headers.join(','),
            ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        ].join('\r\n');

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-categories-${formatTime()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        updateStatus(`CSV 已下载 ✓ ${collectedData.length} 条`);
    }

    function downloadMD() {
        if (collectedData.length === 0) { alert('没有数据！'); return; }
        const lines = [
            '# Ozon 类目采集结果',
            '',
            `> 采集时间：${new Date().toLocaleString('zh-CN')}`,
            `> 共 ${collectedData.length} 条`,
            '',
            '| 序号 | 一级类目 | 二级类目 | 三级类目 | 类目名称 |',
            '|------|----------|----------|----------|----------|',
            ...collectedData.map((d, i) =>
                `| ${i + 1} | ${d.l1 || '-'} | ${d.l2 || '-'} | ${d.l3 || '-'} | ${d.name || '-'} |`
            ),
            '',
            '*Generated by Ozon Category Collector v5.5*',
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ozon-categories-${formatTime()}.md`;
        a.click();
        URL.revokeObjectURL(url);
        updateStatus(`Markdown 已下载 ✓ ${collectedData.length} 条`);
    }

    function formatTime() {
        return new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).replace(/[/:]/g, '-').replace(/\s/g, '_');
    }

    // ==================== 自动检测 ====================

    function refreshTreeContainer() {
        const c = findTreeContainer();
        if (c) treeContainerRef = c;
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

        // ===== 样式 =====
        const style = document.createElement('style');
        style.textContent = `
            /* FAB */
            #ozon-fab-root { position: fixed; bottom: 32px; right: 32px; z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif; }
            #ozon-fab { width: 56px; height: 56px; border-radius: 50%;
                background: linear-gradient(135deg, #005bff 0%, #003d99 100%);
                border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
                box-shadow: 0 4px 16px rgba(0,91,255,0.4), 0 2px 4px rgba(0,0,0,0.12);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); position: relative; outline: none; color: #fff; }
            #ozon-fab:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(0,91,255,0.5); }
            #ozon-fab:active { transform: scale(0.95); }
            #ozon-fab.open { border-radius: 16px; width: 44px; height: 44px;
                background: linear-gradient(135deg, #e8eaed 0%, #dadce0 100%);
                box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
            #ozon-fab svg { width: 26px; height: 26px; transition: transform 0.3s; }
            #ozon-fab.open svg { transform: rotate(90deg); width: 20px; height: 20px; color: #5f6368; }
            #ozon-fab.tracking { background: linear-gradient(135deg, #34a853 0%, #1e8e3e 100%);
                box-shadow: 0 4px 16px rgba(52,168,83,0.4); }
            #ozon-fab.tracking.open { background: linear-gradient(135deg, #e8eaed 0%, #dadce0 100%); }
            #ozon-fab::before { content:''; position:absolute; width:100%; height:100%; border-radius:50%;
                background: rgba(0,91,255,0.3); animation: ozon-pulse 2.5s ease-in-out infinite; z-index:-1; }
            #ozon-fab.tracking::before { background: rgba(52,168,83,0.3); }
            #ozon-fab.open::before { animation:none; opacity:0; }
            @keyframes ozon-pulse { 0%,100%{transform:scale(1);opacity:0.4;} 50%{transform:scale(1.6);opacity:0;} }
            #ozon-fab-badge { position:absolute; top:-4px; right:-4px; min-width:20px; height:20px; padding:0 6px;
                border-radius:10px; background:#e37400; color:#fff; font-size:11px; font-weight:600;
                display:none; align-items:center; justify-content:center; line-height:1; }
            #ozon-fab-tip { position:absolute; right:68px; top:50%; transform:translateY(-50%);
                background:#323232; color:#fff; font-size:13px; padding:6px 12px; border-radius:6px;
                white-space:nowrap; opacity:0; pointer-events:none; transition:opacity 0.2s; }
            #ozon-fab-tip::after { content:''; position:absolute; right:-6px; top:50%; transform:translateY(-50%) rotate(45deg);
                width:10px; height:10px; background:#323232; }
            #ozon-fab:hover #ozon-fab-tip { opacity:1; }

            /* 面板 */
            #ozon-panel { position: fixed; bottom: 100px; right: 32px; width: 720px; max-height: 660px;
                background: #fff; border-radius: 16px;
                box-shadow: 0 12px 48px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.08);
                font-size: 13px; color: #333; z-index: 2147483646;
                overflow: hidden; display: flex; flex-direction: column; line-height: 1.5;
                transform-origin: bottom right;
                transform: scale(0.4) translateY(20px); opacity: 0; pointer-events: none;
                transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease; }
            #ozon-panel.visible { transform: scale(1) translateY(0); opacity: 1; pointer-events: auto; }
            #ozon-panel-header { background: linear-gradient(135deg, #005bff 0%, #003d99 100%); color: #fff;
                padding: 14px 18px; font-weight: 600; font-size: 15px;
                display: flex; justify-content: space-between; align-items: center;
                cursor: move; user-select: none; flex-shrink: 0; letter-spacing: 0.3px; }
            #ozon-panel-header .ozon-header-title { display: flex; align-items: center; gap: 8px; }
            #ozon-panel-header button { background: rgba(255,255,255,0.15); border: none; color: #fff;
                font-size: 15px; cursor: pointer; width: 28px; height: 28px; line-height: 28px;
                text-align: center; border-radius: 8px; padding: 0; transition: background 0.15s; }
            #ozon-panel-header button:hover { background: rgba(255,255,255,0.3); }
            #ozon-panel-body { padding: 16px 18px 18px; overflow-y: auto; flex: 1; min-height: 0; }

            /* 提示 */
            #ozon-mode-hint { margin-bottom: 12px; padding: 10px 14px; border-radius: 10px; font-size: 12px;
                background: linear-gradient(135deg, #e6f4ea 0%, #ceead6 100%);
                border: 1px solid #a8dab5; color: #1e8e3e; display: flex; align-items: center; gap: 8px; }
            #ozon-mode-hint svg { width: 18px; height: 18px; flex-shrink: 0; }

            /* 按钮 */
            #ozon-panel-buttons { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
            #ozon-panel-buttons button { flex: 1; min-width: 90px; padding: 10px 8px; border: none; border-radius: 10px;
                font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
                display: flex; align-items: center; justify-content: center; gap: 5px; }
            #ozon-panel-buttons button:active { transform: scale(0.97); }
            #ozon-panel-buttons button svg { width: 14px; height: 14px; }
            .ob-blue { background: linear-gradient(135deg, #e8f0fe, #d2e3fc); color: #1967d2; border: 1px solid #a8c7fa !important; }
            .ob-blue:hover { background: linear-gradient(135deg, #d2e3fc, #aecbfa); }
            .ob-green { background: linear-gradient(135deg, #e6f4ea, #ceead6); color: #1e8e3e; border: 1px solid #a8dab5 !important; }
            .ob-green:hover { background: linear-gradient(135deg, #ceead6, #b7e1c7); }
            .ob-orange { background: linear-gradient(135deg, #fef3e8, #fce8cc); color: #e37400; border: 1px solid #f5c88a !important; }
            .ob-orange:hover { background: linear-gradient(135deg, #fce8cc, #fad9a8); }
            .ob-red { background: linear-gradient(135deg, #fce8e6, #f7d7d5); color: #d93025; border: 1px solid #f0b8b5 !important; }
            .ob-red:hover { background: linear-gradient(135deg, #f7d7d5, #f0b8b5); }
            .ob-gray { background: #f1f3f4; color: #5f6368; border: 1px solid #dadce0 !important; }
            .ob-gray:hover { background: #e8eaed; }
            .ob-purple { background: linear-gradient(135deg, #f3e8fd, #e8d4f5); color: #7b1fa2; border: 1px solid #ce93d8 !important; }
            .ob-purple:hover { background: linear-gradient(135deg, #e8d4f5, #dcb8e9); }

            /* 选项栏 */
            #ozon-panel-options { display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 10px; padding: 6px 0; border-top: 1px solid #f1f3f4; border-bottom: 1px solid #f1f3f4; }
            #ozon-panel-options label { cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 12px; color: #666; }
            #ozon-panel-options input[type="checkbox"] { cursor: pointer; accent-color: #005bff; }

            /* 状态栏 */
            #ozon-collector-status { font-size: 12px; color: #5f6368; margin-bottom: 12px; padding: 8px 12px;
                background: #f8f9fa; border-radius: 8px; border-left: 3px solid #005bff; transition: all 0.3s; }
            #ozon-collector-status.status-ok { border-left-color: #34a853; background: #f0faf0; color: #1e8e3e; }
            #ozon-collector-status.status-warn { border-left-color: #e37400; background: #fef8f0; color: #e37400; }

            /* 表格 */
            #ozon-collector-results { max-height: 300px; overflow-y: auto; border: 1px solid #e8eaed;
                border-radius: 10px; background: #fafbfc; }
            #ozon-collector-results table { width: 100%; border-collapse: collapse; font-size: 12px; }
            #ozon-collector-results th, #ozon-collector-results td { padding: 8px 10px; text-align: left;
                border-bottom: 1px solid #e8eaed; white-space: nowrap; }
            #ozon-collector-results th { background: #f1f3f4; font-weight: 600; position: sticky; top: 0;
                color: #5f6368; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; z-index: 1; }
            #ozon-collector-results tr:last-child td { border-bottom: none; }
            #ozon-collector-results tr:hover td { background: #e8f0fe; }
            #ozon-collector-results td:nth-child(n+2):nth-last-child(n+2) { white-space: normal; word-break: break-word; max-width: 180px; }
            .ozon-remove-btn { transition: all 0.15s; }
            .ozon-remove-btn:hover { background: #d93025 !important; color: #fff !important; border-color: #d93025 !important; }

            #ozon-result-bar { margin-top: 10px; font-size: 11px; color: #999; text-align: center; }
        `;
        document.head.appendChild(style);

        // ===== HTML 结构 =====
        const root = document.createElement('div');
        root.id = 'ozon-fab-root';
        root.innerHTML = `
            <button id="ozon-fab" title="Ozon 类目采集器 v5.5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
                <span id="ozon-fab-badge"></span>
                <span id="ozon-fab-tip">类目采集器</span>
            </button>
            <div id="ozon-panel">
                <div id="ozon-panel-header">
                    <div class="ozon-header-title">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        <span>Ozon 类目采集器 v5.5</span>
                    </div>
                    <button id="ozon-btn-collapse" title="收起">▾</button>
                </div>
                <div id="ozon-panel-body">
                    <div id="ozon-mode-hint">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                        <span>支持点击逐个采集 + 一键全量扫描（基于 Ozon DOM --level 层级）</span>
                    </div>

                    <div id="ozon-panel-buttons">
                        <button id="ozon-btn-scan-all" class="ob-purple" title="自动扫描弹窗内所有已加载的类目">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <path d="M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z"/></svg>
                            全量扫描
                        </button>
                        <button id="ozon-btn-download-csv" class="ob-orange" title="导出 CSV">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                            CSV
                        </button>
                        <button id="ozon-btn-download-md" class="ob-blue" title="导出 Markdown">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            MD
                        </button>
                        <button id="ozon-btn-clear" class="ob-red" title="清空">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            清空
                        </button>
                    </div>

                    <div id="ozon-panel-options">
                        <label title="控制台输出详细日志">
                            <input type="checkbox" id="ozon-debug-toggle"> 调试模式
                        </label>
                        <button id="ozon-btn-detect" class="ob-gray" style="padding:4px 12px;font-size:11px;border-radius:6px;cursor:pointer;">检测树</button>
                    </div>

                    <div id="ozon-collector-status">就绪 — 请打开「类目」筛选弹窗</div>
                    <div id="ozon-collector-results">
                        <table>
                            <thead><tr>
                                <th style="width:28px;text-align:center;">#</th>
                                <th>一级类目</th><th>二级类目</th><th>三级类目</th><th>类目名称</th><th style="width:36px;"></th>
                            </tr></thead>
                            <tbody id="ozon-collector-tbody">
                                <tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无数据</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div id="ozon-result-bar">共 <span id="ozon-result-count">0</span> 条</div>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        // ===== 事件绑定 =====
        const fab = document.getElementById('ozon-fab');
        const panel = document.getElementById('ozon-panel');
        let panelOpen = false;

        fab.addEventListener('click', () => {
            panelOpen = !panelOpen;
            panel.classList.toggle('visible', panelOpen);
            fab.classList.toggle('open', panelOpen);
            fab.innerHTML = panelOpen
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg><span id="ozon-fab-badge"></span>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span id="ozon-fab-badge"></span><span id="ozon-fab-tip">类目采集器</span>`;
            updateStatus(document.getElementById('ozon-collector-status')?.textContent || '');
        });

        document.getElementById('ozon-btn-collapse').onclick = () => {
            panelOpen = false; panel.classList.remove('visible'); fab.classList.remove('open');
            fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span id="ozon-fab-badge"></span><span id="ozon-fab-tip">类目采集器</span>`;
        };

        document.getElementById('ozon-btn-scan-all').onclick = scanAllCategories;
        document.getElementById('ozon-btn-download-csv').onclick = downloadCSV;
        document.getElementById('ozon-btn-download-md').onclick = downloadMD;
        document.getElementById('ozon-btn-clear').onclick = clearAll;

        document.getElementById('ozon-debug-toggle').onchange = (e) => {
            CONFIG.debug = e.target.checked;
            log('调试模式:', CONFIG.debug ? '开' : '关');
        };

        document.getElementById('ozon-btn-detect').onclick = () => {
            const c = findTreeContainer();
            const status = document.getElementById('ozon-collector-status');
            if (c) {
                status.textContent = `已检测到 ✓ (${c.querySelectorAll('button[style*="--level"]').length} 个行)`;
                status.className = 'status-ok'; treeContainerRef = c;
                log('手动检测成功:', c.className?.substring(0, 40));
            } else {
                status.textContent = '未检测到 ✗'; status.className = 'status-warn';
            }
        };

        // 拖拽
        let dragging = false, offset = { x: 0, y: 0 };
        const header = document.getElementById('ozon-panel-header');
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offset.x = e.clientX - rect.left; offset.y = e.clientY - rect.top;
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
            panel.style.left = rect.left + 'px'; panel.style.top = rect.top + 'px';
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offset.x) + 'px';
            panel.style.top = (e.clientY - offset.y) + 'px';
        });
        document.addEventListener('mouseup', () => dragging = false);

        // 自动检测
        autoDetectTimer = setInterval(() => {
            const c = findTreeContainer();
            const status = document.getElementById('ozon-collector-status');
            if (c) treeContainerRef = c;
            if (c && status?.textContent.includes('请先打开')) {
                status.textContent = `就绪 ✓ (${c.querySelectorAll('button[style*="--level"]').length} 个行)`;
                status.className = 'status-ok';
                if (!clickTrackerActive) { startClickTracker(); fab.classList.add('tracking'); }
            }
        }, 1500);

        // 启动
        startClickTracker();
        fab.classList.add('tracking');
        log('Ozon 类目采集器 v5.5 加载完成');
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
    }

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
