# 缺陷追踪约定（BUG-XXX.md）

每个缺陷一个文件，命名 `BUG-<编号>.md`，编号自 `BUG-001` 起自增。模板如下：

```markdown
# BUG-<编号>: <一句话标题>

- 状态: open | in_progress | fixed | wontfix | closed
- 发现日期: YYYY-MM-DD
- 模块: engine | shell
- 严重程度: low | mid | high | critical

## 现象
<用户/测试观察到的现象>

## 根因
<定位到的代码位置与原因，附 file:line>

## 复现
<最小复现步骤 / 验证脚本>

## 修复
<改动摘要 + 验收方式>

## 关联
<相关 BUG / 提交 / 文档>
```

## 当前登记

| 编号 | 标题 | 状态 | 模块 |
|---|---|---|---|
| BUG-001 | 下载文件不自动嗅探/不按实际文件命名 | fixed | engine |
| BUG-002 | 无法查看每连接状态与分块进度 | fixed | engine+shell |
| BUG-003 | 速度统计失准（完成仍显示/进行中不准） | fixed | engine+shell |
| BUG-004 | 无全局进度状态，状态栏仅计数无实时速度 | fixed | shell |
| BUG-005 | 「打开文件/打开目录」按钮无效 + 纯文字样式不一致 | closed | shell |
| BUG-006 | 侧边栏「全部文件」展开/收起交互行为不纯 | fixed | shell |
| BUG-007 | 内置分类标签不支持多语言设置 | fixed | shell |
| BUG-008 | 自动分类「新增分类行」布局错乱（Input w-full 冲突） | fixed | shell |
| BUG-009 | 自动分类编辑器内置分类名未翻译 | fixed | shell |
| BUG-010 | 前端 BUILTIN_CLASSIFY 与 daemon 规范分类键不一致 | fixed | shell |
| BUG-011 | 运行中反复弹出 Terminal 小窗（spawn 控制台命令未隐藏窗口） | fixed | engine+shell |
| BUG-012 | 无法拉取应用（TG 频道列表失败）且显示已登录但实际会话失效 | fixed | engine |
| BUG-013 | 分组（TG 频道列表）加载极慢，单次全量拉取导致前端拿不到分组 | open | engine+shell |
| BUG-014 | 入库媒体看不到图片/视频，无法选择下载/浏览 | open | engine+shell |
