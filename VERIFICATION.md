# 开源目录验证记录

验证日期：2026-10-22。插件版本：1.0.0。

验证使用本目录的隔离副本；FFmpeg 大文件只恢复到隔离副本，本上传目录保持不含 EXE、DLL 或源码压缩包。未安装或卸载真实 DSH 插件，未修改个人 profile、账号或会话。原有 F 盘 Release ZIP 和校验文件保留不变。

| 检查 | 结果 |
| --- | --- |
| `tools/restore-vendor.ps1` | 从原发布 ZIP 恢复 14 个许可清单锁定的依赖文件，整个 ZIP 和每个文件均核对 SHA-256；重复执行恢复 0 个文件 |
| 恢复脚本拒绝检查 | 错误 ZIP 哈希、内容不同的既有文件、`../` 路径越界均被拒绝；冲突文件保持原样 |
| `tools/test-portable.ps1` | 11 组通过：版本/基础依赖检查、只读检查、安装、回滚、幂等升级、无关配置保护、卸载和越界/运行中拒绝 |
| `tools/test-package.ps1` | 通过：默认源码根、UTF-8 说明、ASCII/CRLF 启动器、标准 ZIP 路径、逐文件哈希、依赖和对应源码材料、拒绝覆盖 |
| `tools/package.ps1` | 在恢复依赖的隔离副本中实际生成完整便携 ZIP 与 SHA-256，默认输出到 dist/ |
| `test/media.test.mjs` 与两个 host 契约测试 | 合计 8 项通过，未跳过；使用真实 FFmpeg 和自备 DSH 0.2.1-rc.2 runtime |
| 运行源码与原发布 ZIP 比对 | lib/index.js、lib/client.js、lib/media.js、cordis.patch.yml 的 SHA-256 完全一致 |
| 上传检查 | 保留第三方许可与版本/来源资料；排除个人部署记录；无个人用户名绝对路径、常见格式密钥或超过网页 25 MiB 限制的单文件 |

8 项媒体及契约测试覆盖 GIF 不等延时/处置/透明、视频时间与 VFR、资源限制与取消、模型能力和会话/文件权限、原生图片输出、真实 schema 与 HTTP 路由契约、同名附件解析和来源选择互斥。

测试环境使用 Windows PowerShell 5.1、Node.js 24。临时目录可通过 `DSH_TEST_TEMP` 配置；真实 runtime 通过 `DSH_TEST_RUNTIME` 提供。安装器 portable.ps1 和生产插件 lib/ 未改变。

可选的真实 DSH 浏览器测试本次未完成：本机无头 Chrome 在启动阶段因 Crashpad 管道错误退出。测试文件保留，ASAR、Chrome、基础插件源码路径均可配置；不能将本记录当作真实浏览器 UI 验收通过。

本次检查不等于对 FFmpeg 全部依赖许可证或对应源码完整性的法律审计。原有许可与来源资料原样保留；分发二进制时仍需按实际组件核对源码和许可材料，见 README 的第三方说明。

原始便携包 SHA-256（恢复脚本使用的固定版本）：

```text
43f8ba1bc5c785dd9e5348f91da8fca5f60bce9e598251af33b79a2f3242860b
```
