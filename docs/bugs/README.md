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
| BUG-001 | 下载文件不自动嗅探/不按实际文件命名 | open | engine |
| BUG-002 | 无法查看每连接状态与分块进度 | open | engine+shell |
| BUG-003 | 速度统计失准（完成仍显示/进行中不准） | open | engine+shell |
| BUG-004 | 无全局进度状态，状态栏仅计数无实时速度 | open | shell |
