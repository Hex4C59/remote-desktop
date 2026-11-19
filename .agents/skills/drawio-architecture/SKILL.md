---
name: drawio-architecture
description: 用 draw.io 绘制、重排和检查系统架构图、部署拓扑、数据流和时序图。适用于根据仓库画图、整理交叉连线、将 Mermaid 改成 draw.io 或修复 Markdown 图表显示。交付可编辑的 .drawio 源文件和 PNG，Markdown 中的 draw.io 图只嵌入 PNG。
---

# Draw.io 架构图

## 输入与输出

读取现有架构图、仓库配置、接口实现或用户提供的系统说明。确认这张图要回答的问题、读者和文档位置。交付同名的 `.drawio` 源文件与 `.png` 图片，例如 `docs/architecture/system-overview.drawio` 和 `docs/architecture/system-overview.png`。

## 从代码到图

1. **核对关系。** 查路由、服务配置、数据模型和任务实现。为每条关系明确调用方、接收方及动作。保留读者需要的接口前缀、监听端口、数据归属和异步任务方向。将条件调用写在线上或图例中。
2. **安排阅读顺序。** 拓扑从客户端、入口、应用服务到数据存储和外部依赖。同一条主链路尽量放在同一行，数据库靠近读写它的服务。时序图按参与方排泳道，时间从上往下走。遇到交叉，先调整节点、接入边和拐点。细节影响总览阅读时，另画登录、作答或导出时序图。
3. **画节点和线。** 统一卡片、对齐线和间距。用标题写服务名，次行写端口、路由或职责。以颜色和文字共同标明分区。设置直角连线和固定接入边，避免箭头穿过卡片、标签或无关分区。虚线用于条件调用或定时投递时，在图例标明其含义。
4. **保存可编辑源文件。** 用 diagrams.net 保存，或生成带 `mxGraphModel` 的 `.drawio` XML。节点用独立单元，边引用节点 ID。保留几何坐标、接入点和必要的转折点。[XML 与导出参考](references/drawio.md)
5. **导出不透明 PNG。** 固定浅底和深色字，按约 2× 导出。优先用已有 draw.io 桌面端的 GUI 或 CLI。需要无桌面端的本地渲染时，使用浏览器脚本。[PNG 导出脚本](scripts/export-png.mjs)
6. **嵌入文档。** 使用相对于 Markdown 文件的路径。正文内嵌图和点击放大的目标都使用同一张 PNG。将 `.drawio` 作为普通文本链接提供。

```markdown
[![系统架构图](docs/architecture/system-overview.png)](docs/architecture/system-overview.png)

[可编辑的 draw.io 源文件](docs/architecture/system-overview.drawio)
```

## 交付前检查

- 查看实际导出的图片，检查箭头方向、文字溢出、中文字体、连线交叉和底色。逐一核对图中的端口、路径和数据归属。
- 在深色 Markdown 预览中检查图片显示和相对路径。在正文列宽下看整体结构，打开 PNG 原图读细节。
- 更新图时从 `.drawio` 重导同名 PNG。交付文档、PNG 和源文件的路径，并说明实际验证的查看器。
