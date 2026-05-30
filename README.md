# Ozon 类目批量采集器

<p align="center">
  <strong>Tampermonkey 油猴脚本</strong> — 一键批量展开 Ozon 卖家后台类目树，采集选中类目并导出 CSV 表格
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
| **展开全部** | 自动递归展开类目树的所有节点，无需手动一个个点开 |
| **采集选中** | 一键提取所有勾选类目的完整路径、层级深度等信息 |
| **下载 CSV** | 导出 UTF-8-BOM 编码表格，Excel / WPS 打开中文不乱码 |
| **检测树** | 手动检测页面上是否有类目树容器 |
| **调试模式** | 控制台输出详细匹配日志，方便排查 DOM 选择器问题 |

## 安装

### 前置条件

- Chrome / Edge / Firefox 浏览器
- 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展

### 安装脚本

1. 点击本页顶部的 **「安装脚本」** 绿色按钮
2. Tampermonkey 会弹出安装确认页面，点击 **「安装」**
3. 登录 [Ozon 卖家后台](https://seller.ozon.ru/)，页面右下角会出现采集器面板

> 也可以手动安装：复制 `ozon-category-collector.user.js` 的内容 → Tampermonkey 图标 → 添加新脚本 → 粘贴保存

## 使用方法

1. 在 Ozon 卖家后台，点击 **「类目」** 按钮打开类目筛选弹窗
2. 采集器面板自动检测到类目树（状态栏显示「就绪 ✓」）
3. 点击 **「展开全部」** — 脚本自动递归展开所有类目节点
4. 在类目树中 **勾选** 你需要的类目
5. 点击 **「采集选中」** — 结果实时显示在面板表格中
6. 点击 **「下载 CSV」** — 导出为表格文件

## 面板说明

- 面板可 **拖拽** 移动，不遮挡后台操作
- 点击标题栏 **「−」** 最小化面板，**「×」** 关闭面板
- 面板可随时重新出现（刷新页面即可）

## 导出字段

| 列名 | 说明 | 示例 |
|------|------|------|
| 完整路径 | 从一级到当前类目的层级路径 | `电子产品 > 手机 > 智能手机` |
| 层级深度 | 类目在树中的层级数 | `3` |
| 类目名称 | 当前类目名称 | `智能手机` |
| 是否叶子节点 | 该类目下是否还有子类目 | `是` / `否` |

## 故障排查

如果采集器无法正常工作（提示「未找到类目树」）：

1. 打开面板的 **「调试模式」** 复选框
2. 按 `F12` 打开浏览器开发者工具 → Console 控制台
3. 点击 **「检测树」** 按钮，查看控制台输出
4. 将日志截图提交 [Issue](https://github.com/vision-png/ozon.seller/issues)

## 技术细节

- 纯原生 JavaScript，无外部依赖
- 三层 DOM 查找策略兜底（语义选择器 → 智能评分 → 弹窗内容区）
- 支持虚拟滚动场景（逐段加载 + MutationObserver）
- 面板 UI 使用内联 CSS，不污染页面样式

## License

MIT
