# 绘图与导出参考

## 可编辑 XML

每个页面用 `<diagram>` 包住 `<mxGraphModel>`。画布和分区先放在根层，服务卡片与连线放在其后。使用唯一的单元 ID，连线的 `source` 和 `target` 引用节点 ID。节点说明有多行时，使用纯文本换行（`&#xa;`）或子文本单元（说明会随卡片一起移动）。**严禁在样式中使用 `html=1` 或在 `value` 中写 `<br>`/`<b>`/`<font>` 等 HTML 标签**——否则本地查看器生成的 `<foreignObject>` 会撑爆 `svg.getBBox()`，导致 `export-png.mjs` 截图失败。

```xml
<mxfile host="app.diagrams.net">
  <diagram name="系统拓扑">
    <mxGraphModel page="1" pageWidth="760" pageHeight="360" background="#f8fafc">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="gateway" value="Nginx" style="rounded=1;fillColor=#163453;fontColor=#ffffff;" vertex="1" parent="1">
          <mxGeometry x="60" y="130" width="140" height="54" as="geometry"/>
        </mxCell>
        <mxCell id="api" value="业务 API" style="rounded=1;fillColor=#ffffff;strokeColor=#95cfc0;" vertex="1" parent="1">
          <mxGeometry x="360" y="130" width="160" height="54" as="geometry"/>
        </mxCell>
        <mxCell id="gateway-api" style="edgeStyle=segmentEdgeStyle;orthogonal=1;endArrow=block;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="gateway" target="api">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

两端高度不同时，在边的 `<mxGeometry>` 内添加 `<Array as="points">`，用 `<mxPoint x="…" y="…"/>` 指定路径拐点。可把路径和监听端口写在卡片里，给连线留出空间。

## 导出 PNG

使用 draw.io 的「文件 → 导出为 → PNG」，关闭透明背景，缩放选 200%。使用已安装的 draw.io Desktop CLI 时，先用该可执行文件的 `--help` 确认可用参数。

```bash
drawio --export --format png --scale 2 --output system-overview.png system-overview.drawio
```

### 本地浏览器导出

浏览器脚本使用 Node.js 24、Chrome 或 Edge、`puppeteer-core` 和 draw.io 官方查看器文件。将依赖和查看器准备在临时目录。`$DRAWIO_EXPORT_DIR` 指向该临时目录，`$DRAWIO_SKILL_DIR` 指向 Skill 目录，`$DRAWIO_BROWSER_EXE` 指向浏览器可执行文件。

```bash
npm install --prefix "$DRAWIO_EXPORT_DIR" --ignore-scripts --no-audit --no-fund puppeteer-core@25.18.1
curl -fsSL https://viewer.diagrams.net/js/viewer-static.min.js -o "$DRAWIO_EXPORT_DIR/viewer-static.min.js"
node "$DRAWIO_SKILL_DIR/scripts/export-png.mjs" system-overview.drawio system-overview.png \
  --viewer "$DRAWIO_EXPORT_DIR/viewer-static.min.js" \
  --deps-dir "$DRAWIO_EXPORT_DIR" \
  --browser "$DRAWIO_BROWSER_EXE"
```

默认导出第一页。用 `--page-index` 指定从零开始的页号，更新已有预览时加 `--overwrite`。脚本通过本地查看器离线渲染，输出固定浅色背景的 2× PNG。有外链图片的图可以先把图片嵌入 draw.io 源文件。
