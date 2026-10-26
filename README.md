# DSH 视频 / GIF 读取

非官方社区插件，包名 dsh-media-reader，版本 **1.0.1**。适配 Windows x64 / DeepSeek Harness Desktop **0.2.1-rc.3**。
需要先安装 dsh-plugin-hub 1.0.1。

导入本地或当前聊天中的原始视频/GIF，按时间抽帧，并通过 DSH 原生图片附件交给当前看图模型。默认 12 帧、最长边 960 像素。

## 安装

普通用户从 Releases 下载完整安装 ZIP 并解压。完全退出 DSH（包括托盘），先运行“检查环境.cmd”，再运行“安装.cmd”，完成后重启 DSH。卸载同样先退出 DSH，再运行“卸载.cmd”。

本源码目录已包含运行所需的预构建 lib/，可在完成必要依赖恢复后直接使用根目录的同名 CMD。无需另外安装 Node、Python 或 npm 运行依赖；安装器使用本机 DSH 自带 CLI，离线注册。

安装位置为 <DSH_HOME>/custom-plugins/dsh-media-reader/<profile>；默认 profile 为 desktop。安装前备份，失败尝试回滚，备份位于 <DSH_HOME>/backups/dsh-media-reader/。不主动关闭用户进程。

自定义路径可执行 `tools/portable.ps1 -Mode Check -DshPath <DSH安装目录> -DshHome <DSH数据目录> -Profile desktop`，确认后将 Check 改为 Install 或 Uninstall。Check 为只读。

## 使用与范围

先安装 dsh-plugin-hub 1.0.1，再在输入框旁的方框加号中选择“视频 / GIF”。导入内容先进入草稿，检查后发送；模型工具 read_media 可读取本地路径或当前会话的原始附件。

不转写声音。GIF 需要原始文件，已经被归一化成静态图片的旧附件不能恢复动画。抽样可能遗漏快速事件，可按时间点继续补抽。单源上限 512 MB / 24 小时，单次最多 24 帧 / 24 MB，并受 DSH 图片限制。文件访问仍遵循 DSH 原有策略。

## 源码依赖恢复

普通用户使用完整的 dsh-media-reader-1.0.1-win-x64.zip 安装。公开源码保留插件 JavaScript 和 FFmpeg 许可/来源资料；FFmpeg EXE、DLL、对应源码压缩包和扩展口袋 1.0.1 从该版本完整安装 ZIP 恢复，不作为网页源码文件重复上传。

在源码根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\restore-vendor.ps1 -ReleaseZip "<下载的安装ZIP绝对路径>"
```

恢复器校验整个 ZIP 和 14 个白名单文件的 SHA-256，不覆盖内容不同的已有文件，不安装 DSH 插件。恢复后再运行检查和安装。生成的 vendor/ffmpeg/bin/、vendor/ffmpeg/source/、.local-deps/ 已在 .gitignore 中排除；网页上传时也应手动排除。

插件源码使用 MIT；FFmpeg 遵循自身及相关组件许可。保留 vendor/ffmpeg/ 中的许可、NOTICE、BUILD 和来源资料；对应源码材料在原安装 ZIP 中并由恢复器还原。

## 公开源码

本目录保留预构建运行文件、必要说明、安装器和许可证。测试、构建分片、内部设计、上传备忘、日志、截图和本机验收记录留在维护工作区。package.json 不保留未分发的开发脚本。根目录 SHA256SUMS.txt 校验随源码分发的文件；安装 ZIP 另有独立的整包校验。

MIT，见 LICENSE。
