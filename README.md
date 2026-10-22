# DSH 视频 / GIF 读取

> DeepSeek Harness 的非官方社区插件。本目录可作为独立 GitHub 仓库的根目录。

普通用户请从 Releases 下载完整安装 ZIP；本目录是开发源码，FFmpeg 依赖需要按下文“恢复媒体开发依赖”还原后才能执行抽帧和完整打包。

`dsh-media-reader` 1.0.0 为 Windows 10 22H2 及以上或 Windows 11（x64）、DSH `0.2.1-rc.2` 提供原始视频/GIF导入、按时间抽帧和当前看图模型读取。前端通过 `dsh-plugin-hub` 1.0.0 的方框加号注册“视频 / GIF”入口，设置统一放在可搜索的“插件配置”中；OAuth 和 Token 用量保持原位。

运行包包含 FFmpeg、ffprobe 和匹配的共享 DLL，不依赖目标机器的 Python、Node、npm 或 PATH。无需另外配置看图模型账号，工具返回 DSH 原生图片附件给当前模型；模型网络请求沿用 DSH 原有配置。

## 安装与移植

发布 ZIP 内含 UTF-8 `使用说明.txt`、ASCII/CRLF CMD 启动器，以及 `dependencies/dsh-plugin-hub-1.0.0-win-x64.zip`。在目标机完整解压，初始化 DSH 后完全退出应用。若缺基础口袋插件，先解压并安装附带的基础 ZIP；已有 1.0.0 不需要重装。再执行媒体包的“检查环境.cmd”和“安装.cmd”。

安装器会在修改前核验 DSH 精确版本、x64 架构、基础插件注册和可读版本，以及抽帧文件是否齐全。它不会自动覆盖已有基础插件。运行目录固定复制到 `<DSH_HOME>/custom-plugins/dsh-media-reader/<profile>`，再调用目标 DSH 自带 CLI 以 `link:` 离线注册；成功后不依赖原解压目录或开发机盘符。

安装、升级、卸载使用 profile 事务备份并验证其他注册状态保持不变，失败时恢复本次事务。备份位于 `<DSH_HOME>/backups/dsh-media-reader/`。卸载不恢复一份陈旧整表，也不删除基础口袋插件、会话或附件；用户偏好 `<DSH_HOME>/dsh-media-reader.json` 保留。

自定义路径示例：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\portable.ps1 -Mode Check -DshPath "D:\Apps\DeepSeek Harness" -DshHome "D:\DSH Data" -Profile desktop
```

把 `Check` 改为 `Install` 或 `Uninstall`。`Check` 为只读，安装或卸载时 DSH 必须完全退出。源文件和安装目标不能互相嵌套，管理目录拒绝路径越界与重解析点。

## 使用与接口

专用导入界面可选择本地文件、当前聊天原始附件或本地路径。导入先加入草稿，由用户检查后发送。GIF 强制走原始文件上传路径，绕开普通图片归一化造成的首帧丢失；已经归一化的旧 GIF 图片不能恢复原动画，需要重新导入。

工具 `read_media` 接受 `file_path` 或当前会话原始文件的 `attachment_id`，两者择一。可指定 `frame_count`、`start_seconds`、`end_seconds`、`timestamps_seconds`；指定时间点替代均匀抽样。本地路径通过 DSH 文件服务读取，保留原有文件访问策略；附件 ID 只从调用会话的原始用户文件块解析。

默认 12 帧、最长边 960 像素，可在插件配置调整；上限为每源 512 MB/24 小时，每次 24 帧/24 MB，另受 DSH 图片限制约束。输出带实际解码时间和请求时间，按时间排序；GIF按一轮处理，考虑不等帧延时、透明与帧处置。临时副本在结束或取消时清理，已提交附件交由 DSH 管理。

切换会话会关闭导入窗口，已经开始的模型任务可以继续在原会话后台运行。取消当前模型任务才会中止对应抽帧；停用插件也会中止进行中的抽帧。

本功能不转写声音。抽样画面不代表完整时间线，快速事件可能遗漏，可继续按时间点或局部片段补抽。

## 构建与验证

运行源码已构建于 `lib/`，运行时没有外部 npm 依赖。完整安装 ZIP 内的许可证和第三方源码资料保存在 `vendor/ffmpeg/`。本开源目录只保留许可与构建资料，FFmpeg 二进制和源码压缩包按下文步骤从发布 ZIP 恢复；第三方组件保留各自许可证，插件自己的源码为 MIT。

```powershell
node --test test/*.test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\test-portable.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\test-package.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\package.ps1
```

默认发布路径为 本项目的 `dist/` 目录（可用 `-OutputDirectory` 指定其他位置）。打包器只接受已验证哈希的基础口袋 ZIP，将其一并放入依赖目录；发布 ZIP 中包含逐文件校验值，所有 ZIP 路径使用标准正斜杠，拒绝覆盖同名发布包。安装器测试使用隔离 profile 和假 CLI，不修改个人数据；它不代替真实 DSH 或另一台物理机器的兼容性验收。

## 开源目录与开发环境

本目录包含可以维护的完整 JavaScript 插件源码。`lib/*.js` 就是现有源码，无需反编译或另找 `src/`；浏览器客户端由 DSH 模块加载器直接加载。插件没有需要从 npm 下载的运行依赖。

- `lib/`：插件源码；`test/`：测试及隔离夹具。
- `delivery/`：发布包用的使用说明和安装/卸载/检查启动器。
- `tools/`：离线安装器、打包器和事务/打包测试。
- `LICENSE`：保留原有 MIT 版权声明；第三方文件保留各自许可证。
- `.gitignore`：忽略测试产物、个人环境配置和发布包；`.gitattributes`：约定文本换行。

开发测试使用 Windows、Node.js 22 或以上、Windows PowerShell 5.1。运行插件只需 README 指定版本的 DSH，不能在普通浏览器直接执行客户端文件。

安装器和打包测试的夹具默认放在系统临时目录并在成功后清理。如 Windows 报路径过长，可将环境变量 `DSH_TEST_TEMP` 设置为较短的可写临时目录，再执行测试；不会改变实际插件的安装位置。

打包默认输出 `dist/`，也可用 `-OutputDirectory` 指定目录。打包器拒绝覆盖同名 ZIP。新改动发布前请更新版本，并重新构建发布 ZIP 与校验文件。

### 可选的真实 DSH 浏览器测试

`test/browser.test.mjs` 使用你自己安装的 DSH 的 React、Cordis 和渲染器；这些第三方应用文件不在源码仓库中。它启动独立无头 Chrome 和临时 profile，不读取真实聊天或账号配置。输出到 `test/artifacts/`。

`DSH_TEST_ASAR` 可指定 DSH 0.2.1-rc.2 的 `resources/app.asar`；不设置时仅尝试当前用户标准安装目录。`DSH_TEST_CHROME` 可指定 Chrome 可执行文件；默认尝试 `C:/Program Files/Google/Chrome/Application/chrome.exe`。

`npm run test:browser` 运行这组可选集成测试。找不到测试环境会明确报错，不会伪装成测试通过。

## 恢复媒体开发依赖

源码目录不附带 FFmpeg EXE/DLL 和大型 tar.gz，不会把它们作为网页源码文件上传。完整便携 Release ZIP 继续包含原有 FFmpeg 运行文件、对应源码快照、构建脚本、许可和基础口袋 ZIP。

1. 从本项目 Releases 下载 `dsh-media-reader-1.0.0-win-x64.zip`，无需先解压。
2. 在本项目根目录执行（把路径换成实际下载位置）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\restore-vendor.ps1 -ReleaseZip "C:\Downloads\dsh-media-reader-1.0.0-win-x64.zip"
```

脚本按 `vendor/ffmpeg/release-manifest.json` 校验整个 ZIP 和每个依赖文件的 SHA-256，只提取允许清单中的文件，拒绝覆盖内容不同的既有文件。不联网、不安装插件、不修改 DSH profile。

恢复后 FFmpeg 在 `vendor/ffmpeg/bin/`，对应源码资料在 `vendor/ffmpeg/source/`，基础口袋包在 `.local-deps/`；这些路径均已加入 .gitignore。网页上传源码时同样要手动排除这三个目录。

### 测试与打包顺序

```powershell
npm run test:portable   # 无需 FFmpeg，使用隔离假 CLI
# 上述 restore-vendor.ps1 成功后：
npm test               # 真实 FFmpeg 的视频/GIF 抽帧测试
npm run test:package   # 隔离打包夹具，核验 ZIP/编码/校验和
npm run package        # 完整便携包输出到 dist/
```

打包器默认使用恢复到 .local-deps 的固定版本基础口袋 ZIP，并核对原发布包的 SHA-256。也可传 `-HubPackagePath` 显式选择同一已验证依赖包。对口袋插件做了新修改后，需要分别发布新版本并更新依赖锁定，不能拿重新打出的不同内容冒充旧依赖。

`npm run test:contract` 需要 `DSH_TEST_RUNTIME` 指向你自己准备的 DSH 0.2.1-rc.2 runtime 根目录（下面有 `node_modules/@deepseek-ai/`），验证原生 schema 与 HTTP 路由契约。

媒体浏览器测试还需要基础口袋客户端源码。默认使用同级的 `../plugin-hub/`；如果分开放置，可设置 `DSH_TEST_HUB_ROOT` 为包含该插件 package.json 的目录。

## 第三方许可与源码

本插件 JavaScript 的 MIT 许可不替代 FFmpeg 及其依赖的许可。保留 vendor/ffmpeg 下的所有许可、NOTICE 与 BUILD 资料。还原的 `source/` 中包含 FFmpeg 源码快照及 BtbN 构建脚本；构建脚本中另外列有依赖源码、补丁和构建参数。它们不是把全部依赖源码合并成一个包，发布二进制前仍需按实际分发的组件核对对应源码材料。

参考：[FFmpeg 官方许可说明](https://ffmpeg.org/legal.html)。原始下载地址、版本和上游 SHA-256 见 [NOTICE.txt](vendor/ffmpeg/NOTICE.txt)，本插件 Release ZIP 的固定 SHA-256 见 [release-manifest.json](vendor/ffmpeg/release-manifest.json)。本次整理保留原发布材料，没有重新编译或改动 FFmpeg。
