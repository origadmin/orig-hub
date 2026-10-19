# 下载/库根目录决策清单（2026-10-16，BUG-323 收尾）

- 状态：**D1 待拍板**（其余「下载目录」问题已在 BUG-323 修完并验收，见 `docs/bugs/BUG-323.md`）。
- 背景：用户 2026-10-16 报「下载设置的目录路径无逻辑」——
  ①无法修改目录（WEB/APP）②默认与库根完全脱离甚至错误 ③目录应默认 Downloads、可切换。
  ①②③已在 BUG-323 修复（默认下载根 = 平台 Downloads 并与库根解耦；WEB 补只读目录浏览端点
  `GET /api/fs/dirs` + 应用内选择器；界面按引擎真值双向对账），23 断言活栈全绿。
  **仅剩 D1 一条**：受管库根的**默认位置**仍在内部 AppData 隐藏路径。

---

### D1. 受管库根的默认位置是否从内部 AppData 迁到可见路径？

- **问题**: `orig-tg/src/store.rs::default_library_root()` 现默认 `<TG 数据目录>/library`
  （Windows = `C:/Users/<user>/AppData/Roaming/com.origadmin.orighub/tg/library`）——
  归仓字节的家是一个用户平时看不见、Explorer 默认不显示的目录；改还是不改？
- **现状与代价**: 现默认值写死在解析链末端（env `ORIG_TG_LIBRARY_DIR` → `app_setting.library_dir`
  → `config.json` → 内部 AppData）。用户诉求「本地文件夹可读」只能靠设置页「打开文件夹」按钮
  （`settings-lib-open`）绕过去，且**默认值本身**不可读。不定 → 库根默认继续与「用户可读的本地
  文件夹」这条产品定位相悖；后续「导出给 EE 上传」「手动整理」都要先让用户去问路径在哪。
- **设计锚点**: `docs/design/cache-root-unification-2026-09-28.md`（R5：存量绝对路径不改写、
  C3：历史根支持）、`docs/MEDIA-DESIGN.md`、`docs/bugs/BUG-323.md`（缺陷②④与本次验收证据）
- **请求**: 选 A、B 还是 C（不做）？

**A. 默认库根改为可见路径 `<用户主目录>/OrigHub/library`（新装与未配置时生效，存量不搬）**

- 涉及: `download-engine/crates/orig-tg/src/store.rs::default_library_root()`、
  `docs/design/cache-root-unification-2026-09-28.md`（C1 补注）、设置页 `downloads.libDirNote` 文案
- 量化: 默认值 1 处改动（约 5 行）+ 文案 2 条；新增 1 个单测（默认根不含 AppData 且可写）；
  存量库根**零迁移**（读 `app_setting.library_dir` 优先，已有值原样生效）
- 回归风险: 中——归仓落点改变意味着「新用户字节落在主目录下」，与「Downloads 默认下载根」形成两个
  可见位置（下载→Downloads、归仓→OrigHub/library）；验收需在独立端口 + 唯一库名跑一次
  ingest 落盘确认（不得碰现网库）
- 后果: 默认库根用户可见、可直接整理与导出；与已拍板的「本地文件夹可读」一致；
  存量安装完全无感（有值的仍读值）

**B. 库根**默认不动**，改为「设置页把库根降级为高级项 + 默认展示真实路径与一键打开」**

- 涉及: `tauri-shell/src/components/SettingsPanel.tsx`（下载页签的库根区块层级与文案）、
  `tauri-shell/src/i18n/locales/{zh-CN,en-US}.json`
- 量化: 0 处引擎/落点变更；前端 2 个文件、约 6 条文案与 1 个区块层级调整
- 回归风险: 低——纯展示层；但要接受「默认仍在 AppData」这一事实，用户仍须点按钮才能看到字节
- 后果: 不动数据落点，风险最低；「库根默认不可读」这条产品矛盾**保留**，
  后续导出/整理相关需求还会再提一次

**C. 不做，维持现状（默认库根 = 内部 AppData，设置页保持原样）**

- 涉及: 无（本期不改任何仓内文件）
- 量化: 0 处变更
- 回归风险: 零
- 后果: 用户诉求里的「始终找不到字节的家」原样保留；BUG-323 只能以「下载目录已修」收尾，
  库根默认位置的争议留到下次反馈再议
