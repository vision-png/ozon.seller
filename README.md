# Ozon 类目批量采集器

<p align="center">
  <strong>Tampermonkey 油猴脚本</strong> — 手动点击采集 Ozon 卖家后台类目树，按一级/二级/三级分列显示，支持导出 CSV 和 Markdown
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/vision-png/ozon.seller/main/ozon-category-collector.user.js" target="_blank">
    <img src="https://img.shields.io/badge/安装脚本-Install_Userscript-1DB954?style=for-the-badge&logo=tampermonkey&logoColor=white" alt="Install">
  </a>
</p>

<p align="center">
  <b>安装方式：</b>点击上方绿色按钮 → Tampermonkey 弹窗点击「安装」→ 刷新 Ozon 后台即可使用
</p>

---

## 功能

| 功能 | 说明 |
|------|------|
| **手动追踪** | 在类目树中点击任意类目行即可记录/取消 |
| **分级显示** | 表格按「一级类目 / 二级类目 / 三级类目 / 类目名称」分列展示 |
| **下载 CSV** | 导出 UTF-8-BOM 编码表格，Excel / WPS 打开中文不乱码 |
| **下载 Markdown** | 导出 `.md` 文档，方便复制到笔记或文档中 |
| **调试诊断** | 开启调试模式后，控制台输出点击元素的完整 DOM 结构，方便定位提取问题 |

## 安装

### 前置条件

- Chrome / Edge / Firefox 浏览器
- 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展

### 安装脚本

1. 点击本页顶部的 **「安装脚本」** 绿色按钮
2. Tampermonkey 会弹出安装确认页面，点击 **「安装」**
3. 登录 [Ozon 卖家后台](https://seller.ozon.ru/)，页面右下角会出现蓝色悬浮按钮

> 也可以手动安装：复制 `ozon-category-collector.user.js` 的内容 → Tampermonkey 图标 → 添加新脚本 → 粘贴保存

## 使用方法

1. 在 Ozon 卖家后台，点击 **「类目」** 按钮打开类目筛选弹窗
2. 采集器自动检测到类目树（状态栏显示「就绪 ✓」）
3. 在左侧类目树中 **点击** 任意类目行（复选框或文字区域均可）
4. 点击一次 = **记录**，再点击一次 = **取消**
5. 采集结果实时显示在面板表格中
6. 点击 **「下载 CSV」** 或 **「下载 MD」** 导出

## 面板说明

- 面板可 **拖拽** 移动，不遮挡后台操作
- 点击标题栏 **「▾」** 收起面板
- 面板右下角显示当前追踪数量（橙色角标）

## 导出字段

| 列名 | 说明 | 示例 |
|------|------|------|
| 一级类目 | 根级类目名称 | `爱好和创作` |
| 二级类目 | 二级子类目 | `创造收纳袋和包` |
| 三级类目 | 三级子类目 | `帆布包` |
| 类目名称 | 当前点击的类目名称 | `帆布包` |

> 如果某级不存在（如只有两级），对应列留空

## 故障排查

如果采集到的类目名称不准确（如显示「添加商品」「类目: 1」等非类目文本）：

1. 打开面板的 **「调试模式」** 复选框
2. 按 `F12` 打开浏览器开发者工具 → **Console** 控制台
3. 点击类目树中识别错误的元素
4. 控制台会输出该元素的完整 DOM 结构（tagName、className、所有子元素文本及宽度等）
5. 将日志截图提交 [Issue](https://github.com/vision-png/ozon.seller/issues)

## 技术细节

- 纯原生 JavaScript，无外部依赖
- 三层 DOM 查找策略兜底（语义选择器 → 智能评分 → 弹窗内容区）
- 类目名称提取采用「最宽纯文本元素」策略，配合黑名单过滤
- 路径构建基于缩进栈算法，自动识别层级关系
- 面板 UI 使用内联 CSS，不污染页面样式

## License

MIT
