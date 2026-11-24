# dsh实时备份 · dsh-backup

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f6bff?style=flat-square)](#安装--卸载)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](#开发)

DSH（DeepSeek Harness）插件：把**工作区对话记录、工作区文件、DSH 插件与应用配置**自动备份到云盘同步目录，
每天一份、同日覆盖，并在 DSH 设置界面提供独立的「备份与云同步」页面（备份状态、云盘同步情况、备份目录与
云盘类型更改入口）。

## 功能

- **启动时自动备份**：每次打开 DSH 后延迟约 5 秒自动执行一次备份（可在设置页关闭）。
- **每天一份、按时间命名**：备份目录为 `<备份根目录>/backup-YYYY-MM-DD_HH-mm-ss`；
  同一天再次备份会先删除当天的旧目录再写入新目录，因此每天只保留最新的一份。
- **备份内容**
  - `conversations/` — 所有工作区的对话记录（`$DSH_HOME/sessions` 全量副本）+ `index.json`
  - `workspaces/<工作区路径标识>/` — 对话涉及的工作区文件（排除 `node_modules`、`.git` 等大目录）
  - `dsh-config/profile/` — 配置档的 `package.json`、`cordis.patch.yml`、`cordis.yml`、锁文件、`.plugin-manager`、`.dsh-market`
  - `dsh-config/home/` — DSH 根目录的其它配置（不含 `.credentials.yaml` 等凭据）
  - `dsh-config/profile-inventory.json` — 已安装插件清单
  - `manifest.json` / `README.txt` — 备份清单与说明
- **设置界面**：DSH 设置 → 侧边栏「备份与云同步」（独立图标与页面），显示
  备份状态、最近一次备份、今日备份、备份位置、备份内容、耗时、云盘同步情况。
- **更改备份文件夹**：按钮调用系统文件夹选择器；若选择器不可用，可「手动填写路径」直接输入并保存。
- **切换云盘**：华为云盘 / OneDrive / 坚果云 / WPS 云盘 / 百度网盘 / 自定义文件夹；
  切换时自动把备份位置指向该云盘的同步目录（未检测到则提示手动指定）。
- **云目录自动识别**：云盘可以装在任意盘符（例如华为云盘在 `D:\华为云盘`）。插件会扫描所有固定
  磁盘盘符下的已知云盘目录，并优先选择「已经存在备份文件夹、且最近写入过」的那个；
  若保存的备份路径本身就位于某个云盘目录内，云盘类型会自动纠正（例如自定义 → 华为云盘）。
- **云同步状态**：备份先写入本地云盘文件夹；检测到云盘客户端进程或同步服务在运行时显示「已同步到云盘」，
  未运行则显示「待同步」，目录不在任何云盘同步范围内才显示「仅本地保存」。

## 安装 / 卸载

要求：DSH 桌面版（支持 bundle 插件与 `plugin_manager`）；插件为纯 Node ESM，仅用内置模块，无需构建、无需 `npm install`。

1. 获取源码：

   ```bash
   git clone https://github.com/TwoFishes08/dsh-live-backup.git
   ```

2. 在 DSH 中按目录安装：让智能体调用 `plugin_manager` 的 `install_bundle`，`target` 填克隆目录的**绝对路径**
   （例如 `C:\path\to\dsh-live-backup`）。
3. 安装会以链接方式把插件挂到 `~/.dsh/profiles/<配置档>/node_modules/dsh-backup`，并在配置档的
   `dsh.profile.bundles` 里登记；按插件管理提示重启 DSH（或关闭再启用 `dsh-backup`）即可加载。
4. 打开 **设置 → 备份与云同步**，确认备份位置与云盘类型；需要时点「更改备份文件夹」。
   DSH 每次启动约 5 秒后会自动执行一次备份。

卸载：在插件管理里移除 `dsh-backup`（或调用 `plugin_manager remove_bundle`，目标 `dsh-backup`），然后重启 DSH。
插件自身的 `dsh-backup` 目录不会被删，可重新安装。

> 插件只读写 `~/.dsh/sessions`、`~/.dsh/profiles/<配置档>` 的配置文件和当前对话涉及的工作区目录；
> 备份时明确跳过 `.credentials.yaml` 等凭据文件。

## 状态与配置文件

- `~/.dsh/dsh-backup/settings.json` — 插件设置（云盘类型、备份根目录、是否启动备份、排除项）
- `~/.dsh/dsh-backup/status.json` — 最近一次备份的状态与结果
- `~/.dsh/dsh-backup/runtime.json` — 诊断信息：本次运行是否找到 `connection` 服务、是否注册了
  HTTP 路由（`connectionReady` / `routesRegistered`）。设置页面读不到状态时先看这里。
- `~/.dsh/dsh-backup/staging/` — 备份暂存目录。每次备份先在这里组装，成功后再复制到云盘目录；
  正常结束后自动删除。若某次备份在「写入备份文件夹」阶段失败，这里会保留当次内容，可手工取出。

## 常见问题

**设置页面显示「备份服务尚未就绪 / not found」**

宿主侧的 HTTP 路由依赖 DSH 的 `connection` 服务。插件现在声明了 `inject = ['connection']`，
并会在服务晚到时自动重试注册，启动备份也不再依赖该服务；正常情况下打开设置页即可看到状态。
若页面仍停留在旧的错误信息，刷新一次页面（Ctrl+R）即可；插件本身已随本次修复重新加载。

**云盘明明在 D 盘，却显示「仅本地保存」**

旧版本只在用户目录（`C:\Users\<用户名>\...`）里找云盘目录。现在会扫描所有盘符，并按备份路径
自动识别云盘类型；已经保存的自定义路径会在插件加载时自动升级为对应的云盘（例如华为云盘）。
如果仍显示「仅本地保存」，确认备份根目录确实在该云盘的同步文件夹内（例如 `D:\华为云盘\...`）即可。

**备份失败：`EPERM: operation not permitted, rename ...`**

1.0.1 之前的版本在云盘同步目录里先写临时目录、成功后重命名。华为云盘 / OneDrive 等同步客户端
在新文件正在上传时会持有句柄，重命名整个目录会被云盘过滤驱动拒绝（`EPERM`），于是当次备份失败。

1.0.1 起改为：**先在 `~/.dsh/dsh-backup/staging/` 组装，成功后再复制到 `backup-<时间>` 目录**，
不再对云盘目录做重命名；写入时的临时锁（以及杀毒软件扫描）会重试几次。只有新备份复制完成后，
才会删除当天旧的备份，因此中途失败不会丢掉上一份。

如果仍然失败，错误信息会指出是哪个文件以及保留的暂存目录；把该目录里的内容手工复制到备份根目录即可。

## 恢复备份

1. 打开备份目录中的 `backup-YYYY-MM-DD_HH-mm-ss/`；
2. `conversations/` 复制回 `~/.dsh/sessions/`（保留原工作区目录名）；
3. `workspaces/<标识>/` 复制回对应工作区根目录；
4. `dsh-config/profile/` 覆盖回 `~/.dsh/profiles/<配置档名>/`（建议先退出 DSH）。

## 开发

- `index.js` — 宿主侧（Node ESM，仅用内置模块）：调度备份、文件拷贝、HTTP 路由
  `/api/dsh-backup/state`、`/api/dsh-backup/action`
- `client.js` — 客户端（React，注册 `settings.section` 槽位，`id: dsh-backup`）
- `tests/backup-test.mjs`、`tests/api-test.mjs`、`tests/state-check.mjs`、`tests/late-connection-test.mjs`
  — 用假 Context 离线驱动宿主侧行为的脚本（`state-check` 只读，打印设置页会收到的状态与云盘识别结果）
- 修改后：重新加载插件（在插件管理里关闭再启用 `dsh-backup`）即可生效；本插件以链接方式安装，
  不需要重新 install。

> 说明：云盘同步进度不是 DSH 可观测的信息，页面中的同步状态依据「备份目录是否位于云盘同步目录内」
> 与「云盘客户端进程 / 同步服务是否运行」推断，不代表单个文件的上传完成度。

## 已知限制

- 云盘目录识别针对 Windows（扫描 C–Z 固定磁盘、`tasklist` 进程、`sc query` 服务）；macOS / Linux 上
  需手动指定备份目录，此时云盘类型可能显示为「自定义文件夹」。
- 备份为文件级复制，不做增量与压缩；先在本地暂存再复制到云盘目录，因此一次备份会写入两份数据
  （暂存副本在成功后删除），工作区体积很大时会更慢（可在设置页查看进度与耗时）。
- 工作区中默认排除 `node_modules`、`.git`、`dist`、`.venv` 等目录，可用 `workspaceExcludes` 调整。
- 备份目录里只保留**同一天**的最新一份；跨天的历史备份不会被自动删除，也不会自动轮转。

## 许可证

[MIT](LICENSE) © dsh-live-backup contributors

如果这个插件帮到了你，欢迎在仓库点一个 ⭐，或在 Issues 里反馈云盘路径识别、备份内容取舍等问题。