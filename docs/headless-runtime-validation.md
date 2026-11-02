# Headless Linux 第一阶段验证报告

2026-11-01；基线 `85002b04fc`；分支 `perf/headless-runtime-stage1`。

## 结论与范围

已拆分 CLI／后台／TUI 的加载边界，减少前台内存及 CLI 启动 CPU，修复真实 PTY 无信号断开后的残留和清理时的 EIO。全部业务模块保留；后台常驻内存尚无稳定改善证据，不宣称 daemon 已完成轻量化。

在线 VPS 未修改、未重启、未部署。测试在本机 WSL Ubuntu 26.04 使用新建未登录 profile，没有复制真实账号配置、访问用户工作目录或发起收费推理。

## 实现

- 保留 cli.js 和命令参数；按命令加载 service、TUI、browser，doctor 的浏览器检查也延迟加载。
- ESM 分块与入口同目录，保持资源路径；清理旧生成分块，避免陈旧产物进入包。
- terminalText 提取为纯文本模块，原 UI 导出兼容，CLI 不再通过该函数加载 Ink。
- TUI 处理 stdin end/close、SIGHUP、SIGTERM、EIO/EPIPE，卸载界面、关闭客户端并撤销监听器；等待 Ink 最后一帧的异步错误完成。其他错误仍暴露。
- 未调用后台停止接口；未改模型、权限、协议、数据库迁移、账号区域或引擎回收策略。

## 最终资源对照

相同独立包依赖、官方 Node 22.22.0、构建版本、Global 区域及新 profile。基线包只换回原始单文件 CLI，worker 与资源不变；从独立 profile cwd 启动。

| 指标 | 基线 | 优化版 |
| --- | ---: | ---: |
| TUI PSS | 482.4 MiB | 108.6 MiB |
| --version 峰值 RSS 中位数 | 508.9 MiB | 112.4 MiB |
| --version CPU 秒中位数 | 3.609 | 0.483 |
| --version 墙钟秒中位数 | 3.037 | 0.326 |
| --help 峰值 RSS 中位数 | 508.0 MiB | 111.0 MiB |
| --help CPU 秒中位数 | 3.607 | 0.469 |
| 后台 PSS 采样范围 | 501.5–544.6 MiB | 542.0–542.3 MiB |
| 后台单核 CPU，10 秒窗口 | 0–5.40% | 0–0.30% |

TUI 减少约 373.9 MiB（77.5%）；CLI 查询峰值内存减少约 78%，启动 CPU 时间减少约 87%。CLI 每条命令重复三次，CPU 是用户态与内核态之和。RSS 与 PSS 不混用。两版 TUI 的 10 秒 CPU 窗口均为 0%，不宣称空闲 CPU 改善。

后台包含启动和垃圾回收波动：基线后段约 502.5 MiB，优化版约 542.3 MiB，反而更高；不能据此证明后台内存下降，也不把短窗口 CPU 差值解释为稳定节省比例。测量不包含登录、活跃 Agent、浏览器或并发业务。早期源码目录的 83% TUI 降幅不作为最终指标。

原始数据：`headless-runtime-results.json`；工具：`apps/cindy-terminal/scripts/measure-headless.py`。

## 真实断线回归

无信号关闭 PTY：基线 5 秒仍存活，需测试器回收；最终包 exit 0，无残留。普通挂断以 SIGHUP 退出；SIGTERM 和 Ctrl-Q 清理后 exit 0。后台始终存活。stdin end/close 和 EIO 单测均先红后绿；最终包无未处理的 EIO，不把信号退出称为 exit 0。

## 验证账本

- typecheck、完整构建、help/version、diff 检查通过；构建有既有 image-resizer direct-eval 警告。
- check-entry-loading.mjs 通过：CLI 静态闭包无 service/React/Ink/TUI，后台无 React/Ink/TUI。
- input、authentication、lifecycle、service-manager、maintenance、shell 六文件 56 项通过，Vitest 9.40 秒。lifecycle 直接通过 Node 运行 Vitest 单独验证：3 项通过，Vitest 3.01 秒、墙钟 3.82 秒，满足 5 秒预算；经 pnpm 启动的早期记录为 5.66 秒。
- 生产 package-runtime 打包及自带原生依赖/help/version smoke 通过；最终独立包从非安装目录启动服务、查询状态并完成 PTY 验证，分块、数据库和 worker 路径可用。
- Linux 宿主/远控集成测试优化前后均为 33 通过、3 失败、1 Windows 专用跳过。未修改源码基线实际复现相同失败：task tags 与 locked vault 两例显式 5000ms 超时；通知文本预期 Finished，实际 Finished private path。未放宽断言、超时或脱敏行为。
- 集成通过项包含真实私有传输、事件、连接恢复、文件服务、数据库重启、附件、加密配置交接、工作目录及客户端释放。
- Windows 同组 33/37 通过，另有三个路径相关失败，不作为 Linux 成功证据。
- check:test-hygiene 失败于五个未修改的 Desktop 基线计数：agent-input-coordinator、orcaWorkerCreationService、deviceProvidersCache、useFeishuBot、WebMicAudioEngine.keepAliveIdle。未修改门禁基线放行；没有声称整仓 CI 全绿。

未执行真实账号的 Desktop/Mobile 端到端操作或模型推理，不能据此声称所有业务组合均已验证。

## 环境和复现

Ubuntu 自带 Node 22.22.1 未编译 TypeScript 支持，原始 TS migration 报 ERR_NO_TYPESCRIPT；正式测量使用打包固定的官方 Node 22.22.0。官方 linux-x64 tar.gz SHA256：`c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744`。向量扩展从本地文件补齐并核对 LFS 哈希；没有修改 native 源码或迁移。引擎及 Electron 下载有网络失败，本次未使用这些引擎推理。

```sh
APP_VERSION=0.1.115 pnpm --filter cindy-terminal build
node apps/cindy-terminal/scripts/check-entry-loading.mjs
CINDY_MEASURE_NODE=/absolute/runtime/node python3 apps/cindy-terminal/scripts/measure-headless.py /absolute/app/dist/cli.js /absolute/resources.json
CINDY_MEASURE_NODE=/absolute/runtime/node python3 apps/cindy-terminal/scripts/measure-headless.py /absolute/app/dist/cli.js /absolute/cli.json --cli-only
```

--lifecycle-only 仅检查断线。诊断/profile 在临时目录，工具只回收自己创建的进程；报告记录失败，不用脚本返回码替代逐项结果检查。

中国大陆版通过 CINDY_AUTH_REGION=cn 构建，build-info 已核对为 cn，启动和全部生命周期 smoke 通过，后台保持存活；正式资源对照为 Global 未登录环境。任何在线替换均不属于本轮交付。

大陆版交付包 SHA256：`7a29142fde65f26d867e6cbc47f7686534d8437e52179403f1924f0cc974486e`。包为本次本地验证构建，不等同于上游正式发行版或已通过完整 CI 的版本。

## 后续迁移门禁复核（2026-11-01）

替代草稿 PR #8342 已包含入口优化和 Codex 空闲回收。对主干 `96cc30181e` 的只读 `git merge-tree` 预演报告 364 处冲突；没有在当前 worktree 发起合并，也没有修改原工作区的未完成合并。GitHub 标记 CONFLICTING；当前仅 DCO 检查成功，不能将没有运行的 client-ci 视为通过。

Desktop 全量类型检查确认仍有共享提取后的接口缺失与宿主适配错误。本次先修复六处诊断：两个共享翻译接口按实际调用收窄为只接受 key，Desktop 适配器保持默认语言；通知宿主导入共享 payload 类型；调度接口按实际调用收窄 provider / Fast 输入，并允许 worktree 释放返回结果（调用方只等待完成，不消费结果）。没有删除断言、添加类型强转或改变工作区回收行为。

最终定向回归：generatedImageDelivery、runnerShared、runnerSessionClose 三文件 36 项通过（30.55 秒，收集 24.26 秒、执行 5.25 秒）。没有新增测试，沿用真实图片交付入口和调度生命周期覆盖。完整 Desktop 类型检查与主干合并仍是未完成门禁；本轮不部署在线 VPS。

最终 app-runtime 和 cindy-terminal 类型检查通过；Desktop 按项目 12 GB 堆预算执行完整检查后仍有 270 条其它诊断，本次涉及的六处诊断已消除。文档检查 10 项通过，diff 检查通过。Desktop 增量缓存仅写入本机临时目录，不进入仓库。

后续整合应按行为迁移，而非给旧类型补空字段：优先核对 maker-ipc 的宿主回调与任务生命周期，其次供应商组／分享的 Fast 策略、插件模拟安装证据与迁移、伙伴云端能力应用与到达提示。冲突中的 Desktop 转发文件需与对应共享包一起检查，不能只保留转发语句而丢掉主干新增实现。各模块继续遵循专项权限、插件兼容和协议规则，未完成前维持草稿。

### 初始化时序与测试隔离修复（2026-11-01）

修复 Desktop 在 inputCoordinator 初始化前装配队列服务时的提前读取：三个共享工厂在调用时读取宿主依赖，Desktop 使用 getter 注入。自动恢复生命周期移入 providerGroupService 所在作用域；补齐运行时设置宿主的 getSessionProvider，并允许数据库 agent kind 的既有 null 返回值。没有改变队列授权、持久化格式或传输协议。

sessionControlService.test.ts 的新增 unit 回归通过真实三个工厂复现初始化前的 ReferenceError，再验证初始化后的队列读取与控制入口；旧实现先失败，修复后全文件 23 项通过（单独运行墙钟 4.13 秒）。既有用例只使用已初始化依赖，未覆盖该启动时序。Terminal 真实宿主队列、协作、共享和账号限额恢复定向集成 4 passed、121 skipped，55.37 秒。

deviceProvidersCache、useFeishuBot、WebMicAudioEngine.keepAliveIdle 保留既有行为断言，改用生产缓存驱逐／解绑／音频模块释放入口隔离用例，不再逐例 resetModules。麦克风竞态用例完成断言后显式停止录音。三文件单独运行墙钟分别为 3.49、4.47、2.47 秒；与 sessionControlService 合跑 90 项通过（Vitest 6.49 秒）。这些测试只调整夹具，不新增产品清理 API。

app-runtime 与 cindy-terminal 类型检查通过。Desktop 完整复查仍有 259 条诊断（此前 270），本批涉及的测试与共享队列模块无诊断；并非全量通过。test-hygiene --update 仍在可信基线比较阶段拒绝五项既有上调，未执行收紧，基线未修改；其中三个 resetModules 源码问题已修复，两处源码读取测试仍待迁移。主干冲突、完整 CI 与余下类型错误仍未解决，不修改在线 VPS。

### 队列测试迁回生产入口（2026-11-01）

agent-input-coordinator.test.ts 的远程入队与插话测试曾从 register.ts 截取已迁走的实现；主人编辑测试还误截取相邻清理代码。现改为注册共享 makerInputSubmission 处理器、调用 sessionControlCoordinator，并将现有编辑来源与授权判定原样提取为 createQueuedEditProvenance，由 Desktop 和测试共用。主人编辑刷新正文授权、共享访客保留原授权、账号与输入代次检查均保留；不改 wire、持久化或插件批准机制。入队夹具现在经过真实参数验证，并使用真实附件生命周期组件。

保留原有三组 unit 断言，15 passed、582 skipped，最终定向运行 11.71 秒（收集 11.02 秒、执行 227ms）；未新增测试文件。该存量巨型文件包含 597 项测试和大量运行时依赖，冷收集已超过 5 秒预算，本轮不增加逐例加载或真实等待。完整文件复查 583 passed、14 failed，29.18 秒；此前 576 passed、21 failed，消除 7 项失效源码夹具造成的失败。余下失败涉及插话失败后的活跃状态、调度人工恢复、拒绝 compact 后的恢复与伙伴原话转发，不能宣称队列整体通过。

共享 app-runtime、cindy-terminal 类型检查通过；Desktop 完整检查仍为 259 条诊断，本次夹具和 makerInputSubmission 无新增诊断。门禁原始 scanRepository 复查先前五个文件，仅 orcaWorkerCreationService.test.ts 仍有 sourceReads=1，其余不再命中。正式门禁仍受当前分支的既有基线上调阻挡，尚未收紧基线。继续处理 Orca 生产授权入口和共享运行时的行为迁移；PR 仍为草稿。

### 调度恢复与已核实原话迁移（2026-11-01）

从主干迁回共享协调器的调度失败继续资格：仅已持久化且未成功撤回的调度失败设置 errorCanContinue，停止／清错重置资格，不保存或重放已结束的调度 prompt。投影字段为可选，旧宿主缺失时客户端按不可继续处理；Desktop/Mobile 已有消费者。插话被 vendor 拒绝后若产品仍有活跃后台工作，不再合成 done 或错误地启动下一轮。

迁回 verifiedOwnerRequestText 及审核历史恢复中的原话读取：只接受已有 host-owned 回执中的 true 标记、来源任务和消息标识及非空原话；未核实回执、插件与共享访客历史不会因此成为主人授权。队列发送、插话和持久化历史使用同一解析器；不修改系统提示词。发送端伙伴身份裁决与 IM 主人输入读取尚待迁移，不能声称原话链路已完整接通。

既有 agent-input-coordinator 全文件 597 项通过（修复前 14 失败）；与 autoReviewUserIntent、forwardedRequest、数据库 autoReviewProjection 合跑 693 passed、3 failed，31.32 秒。三项失败均在 forwardedRequest 的发送端：尚未接入 ownerVerified 参数及 ownerChannelInputEvidence，未放宽断言。Terminal 真实宿主定向集成 4 passed、121 skipped，54.41 秒。没有新增测试或改动既有测试断言。

app-runtime、cindy-terminal 类型检查通过。maker-shared 没有 typecheck script，因此额外执行其 build（tsc --noEmit）：发现存量 findLastIndex 与 ES2022 lib 不兼容，改为等价倒序查找后通过；五组空列表、无撤销、仅撤销及多次撤销输入与原行为一致。该改动不提高运行时语言版本要求。主干冲突、完整 CI、正式 test-hygiene 与发送端身份迁移仍未完成，在线 VPS 不变。

最终 Desktop 全量检查为 241 条诊断（本批之前 259），共享恢复与原话解析代码无新增诊断；队列测试中仍有原有重复 statDirectory 夹具字段的诊断，发送端缺失接口也仍报告类型错误。未将这些错误隐藏或标为通过。文档检查 10 项通过，diff 检查通过。

### 伙伴身份与发送端原话证据（2026-11-01）

共享 taskActionHost 补回当前分支伙伴自主范围合同，区分 owner、entrusted 和 autonomous，并隔离独立工具调用的授权上下文。采用主干 `7eb991b79c^` 对应行为；后续主干已调整伙伴策略，合并时必须同步迁移规则、实现与测试，不能只选一侧代码。Desktop 与 Terminal 均接入工作台真实任务归属查询，Terminal 随伙伴服务解绑一并清理查询回调。

发送端仅为本轮宿主核实的伙伴主人请求写入 ownerVerified，不继承旧回执标记。IM 原话从同一任务、同一 clientId、未撤回的用户消息读取；普通任务保留原有正文。远程发送复用本机相同捕获入口，账号切换仍中止交付。不新增数据库角色或 migration。

沿用既有生产入口测试：taskActionAuthorization、botWorkbenchAccess、forwardedRequest 三文件 145 项通过（9.40 秒）；原发送端失败已消除。companion-core、app-runtime、cindy-terminal 类型检查通过。Desktop 完整类型检查仍有 232 条诊断（本批之前 241），本批授权及原话捕获模块无诊断。

Terminal 宿主五项定向集成因 Windows libuv `src/win/fs-event.c:72` 原生断言崩溃，继发 ERR_IPC_CHANNEL_CLOSED；启用 Chokidar polling 和缩小至四项分别重试仍复现，未获得有效通过结果。未修改产品监听行为、放宽测试或将该组计为成功。此项、其它 Desktop 类型错误、Orca 测试门禁及主干冲突仍待解决，PR 保持草稿，在线 VPS 未修改。

### Windows 临时目录别名复验（2026-11-01）

上述 libuv 崩溃与本机 TEMP 的 Windows 8.3 路径别名有关：普通 realpath 保留短用户名，realpathSync.native 返回长用户名。仅将测试进程 TEMP/TMP 指向同一物理目录的长路径，同组 5 项宿主集成通过（50.42 秒）。测试夹具现统一先用 realpathSync.native 解析临时目录，再创建隔离子目录；未修改产品 watcher 或断言。

恢复默认 TEMP/TMP 后，同组 5 passed、120 skipped（53.83 秒，收集 39.82 秒、执行 13.60 秒），Terminal 类型检查通过。沿用真实宿主与 SQLite 的既有集成用例，没有新增用例、模块重载或真实等待；该存量宿主文件的收集成本仍超过单测预算。本项只验证测试环境恢复，不代表产品已全面支持 Windows 短路径监听，也不代表完整宿主回归或 CI 已通过。

完整宿主文件复查为 116 passed、9 failed（251.76 秒，收集 41.27 秒、执行 210.09 秒），没有原生监听崩溃。失败分别为恢复归档任务仍返回 archived、五处宿主路径比较差异、跨电脑切换 5000ms 超时、脚本用例清理 ENOTEMPTY，以及项目自动化按斜杠形式重复登记同一目录。需分别确认产品回归与断言语义，不将这些失败归为已解决。原始 test-hygiene 扫描与 origin/main 基线比较，仅 Orca worker creation 测试的 sourceReads=1 超标；未修改基线。

### 宿主路径语义与计划授权复核（2026-11-01）

归档恢复的 CAS 要求提交读取到的目录身份，夹具改为传入创建接口返回的 workingDir；原实现不改。工作目录断言按宿主文件系统语义使用 path.normalize／realpath，不改远程协议格式或整段输出。Git 基线夹具用隔离目录中的空配置文件替代 Git for Windows 无法读取的 Node os.devNull。

两项产品修复：项目自动化启动扫描以已登记 schedule 的目录写法为先，同一 Windows 路径的大小写或斜杠变体不再被 session 覆盖，避免重启新增另一个 hash 记录；不迁移或删除已有数据。插件 Worker 的计划授权读取器对 realpath 结果与持久目录使用相同宿主路径规范化，避免正反斜杠导致误拒绝；仍复核插件归属、计划路由、账号代次及最终数据库快照，不改批准状态、凭证、安装布局或 wire。

原有 7 项失败回归现全部通过（79.86 秒，收集 39.54 秒、执行 39.90 秒），包含真实 SQLite、Git、插件安装与撤权、工作树回收和调度重启；未新增用例或放宽超时。项目自动化 13 项通过（3.90 秒）、插件授权 78 项通过（3.54 秒），app-runtime 与 Terminal 类型检查通过。脚本 capability 用例单独重跑通过，但全文件曾出现的清理竞态仍未证实解决。跨电脑切换用例单独重跑仍 5000ms 超时，并在影子目录清理报 EPERM；重复 p 层是既有固定祖先目录布局，不是递归复制。完整宿主文件尚未在本批修复后重跑，不能据此宣称 125 项全绿。Desktop 232 条诊断、主干冲突、Orca 测试门禁与完整 CI 仍待处理，在线 VPS 未修改。

### Orca 生产授权入口与测试卫生门禁（2026-11-01）

将 register.ts 中 Orca 插件身份捕获及 Worker 计划校验原样提取到 app-runtime/orcaPluginAuthority，Desktop 注入现有宿主依赖。对照提取前源码确认两段生产逻辑仅改变依赖访问方式与类型边界；账号代次、原始输入来源、撤权、目录、路由和排队期间的复核顺序不变。测试直接调用生产工厂，不再读取 register.ts 或用 new Function 动态编译。401 项既有创建与生命周期回归全部通过（15.95 秒，收集 14.92 秒、执行 489ms）；该存量巨型文件的依赖收集仍超过预算，没有新增测试文件或逐例模块重载。

修复 --update 的收紧流程：普通检查仍拒绝高于可信主干的本地基线；更新时先扫描实际源码，只有结果同时不高于本地基线和可信主干才允许生成替换文件。原有真实 CLI/Git 隔离回归补入“源码已修复、旧基线仍偏高”的最小输入，既有剩余违规、手工抬高、基准缺失与损坏拒绝断言保留；4 项通过，整文件 4.72 秒（Node 报告 4.39 秒）。这是脚本 CLI 集成回归，不放宽普通测试门禁。

由 --update 自动生成的基线仅删除先前五项债务；正式 pnpm check:test-hygiene 通过（349 files within baseline）。app-runtime 与 Terminal 类型检查通过；Desktop 完整类型检查仍为 232 条诊断，本次提取模块及 Orca 测试无新增诊断。主干冲突、完整 CI、剩余类型迁移及宿主跨电脑超时／清理竞态仍未解决，PR 保持草稿。

### 工作树启动维护与快照清理预算（2026-11-01）

共享维护器接回 onReady、首次启动 30 秒延迟及每 128 项让出事件循环的 owner 索引，避免重复扫描全部任务。Desktop 接回完整当前／历史恢复记录读取与快照清理：记录损坏不清理，未知 owner 不视为已删除；完成证据扫描后，每仓库一次读取 refs，Git 阶段总预算 5 秒、单次调用 1 秒，删除仍校验预期 commit。停止、数据库切换或就绪状态丢失会中止后续清理。Terminal 未注入快照清理端口，不新增其删除行为。

24 项真实 Git 恢复回归全部通过（执行 70.91 秒），覆盖分支并发、历史证据、部分删除恢复和快照回收。同次运行随后在文件监听测试触发 Windows 短路径 libuv 断言，不能计整组通过。仅将测试进程 TEMP/TMP 指向同一物理目录的长路径后，两个 watcher 文件共 6 项通过；与维护测试合跑为 39 passed、2 failed，2.75 秒。余下两项是旧 archive 暂停记录的一次性重试，依赖尚未完整迁入的旧归档退役链，未放宽断言或暂停规则。

worktree-core、Terminal 类型检查通过；Desktop 完整检查为 226 条诊断（本批之前 232），本批生产代码无诊断。仍缺少旧归档清理／重试接口，完整 CI、主干冲突及此前记录的其它迁移问题未解决。在线 VPS 未修改，PR 继续保持草稿。

### Desktop 旧归档退役与缺失目录收尾（2026-11-01）

Desktop 接回主干旧归档退役入口：完整读取当前／历史记录，只清理超过两小时且无人引用的归档；不可读记录阻止清理。在资源锁内复查 generation 后，为符合旧归档失败条件的暂停记录提供一次持久化的新预算，身份异常、用户保留和新快照记录不放宽。Terminal 仍保留 archiveOnSnapshot，不注入此退役入口。共享回收器补回目录已经不存在时的收尾，仍检查主人意图及 generation，并保留其他活跃 owner 的注册。

managedWorktreeRecycle 原有测试的全量 mock 缺少共享工厂加载所需导出，改用 partial mock 保留真实导出，断言不变。该文件与维护测试共 70 项通过（5.06 秒），修复此前两项重试失败及缺失目录收尾失败；前者单独运行 35 项、3.65 秒。未新增用例。真实 Git 恢复 24 项再次全部通过（73.06 秒）。与运行时租约文件合跑为 73 passed、6 failed（76.60 秒）；六项失败集中于尚未迁入共享 runtimeLeases 的心跳、进程身份和开机时间判据，不能视为整体通过。

worktree-core、Terminal 类型检查通过；Desktop 全量检查 224 条诊断，较上一批减少两条；共享回收器最后一次收尾修改后另跑 worktree-core 类型检查通过。test-hygiene 通过（349 files within baseline）。完整 CI、主干冲突及其它迁移问题仍未完成，在线 VPS 未修改。

### 租约心跳、进程身份与多宿主占用（2026-11-01）

共享 runtimeLeases 迁回主干心跳与失效证据判断：每五分钟刷新持有租约的文件时间，写入可选 OS 身份；首次身份查询最多等待两秒。确认 owner／已记录子进程已退出或 PID 复用后，才允许按开机时间或宽限忽略遗留占用，有心跳计一小时，旧记录计二十四小时。活跃兼容实例、未知身份与仍存活的子进程继续保护。仍为 version 1，不删除租约或恢复文件，不改远程协议与 SSH 路径。

共享工厂引入额外的同进程多宿主边界：heldLeaseFiles 必须为进程共有，否则另一个宿主会将相同 PID 下较旧的心跳误判为旧进程遗留。沿用 Terminal worktrees/host.test.ts 的真实占用测试，在租约仍被持有时将时间调到二十五小时前，再经另一生产工厂读取；原先实例局部集合先失败，改为进程共有后通过。没有新增测试文件、真实等待或模块重载。该 integration tier 使用真实 Git、SQLite 与 Node archive worker，全文件 3 项通过（28.09 秒，收集 12.55 秒、执行 15.09 秒）；保留原有恢复与释放断言。

Desktop 租约、进程身份、回收与维护四文件 172 项全部通过（8.29 秒），先前六项租约失败消除。Desktop 全量类型检查仍 224 条诊断，本批文件无诊断；共享 worktree-core 与 Terminal 类型检查另行复核。未验证真实账号多端长期负载；主干冲突、完整 CI 和余下类型迁移仍未完成，在线 VPS 未修改。

### Desktop Pi 空闲回收接线（2026-11-01）

registerMakerIpc 补回主干 Pi watcher 的启动与重新注册清理，并导出 bootstrap 退出路径已调用的 stopPiIdleReleaseWatcher。每五分钟扫描空闲三十分钟的本机普通桌面及插件 Pi 任务；归档纳入，其他隐藏任务、伙伴、IM、Orca、SSH 与其他设备任务排除。扫描与发送锁内复查使用同一 SQL 条件及最新活动时间，保留回合、后台任务、待续跑、自动续跑和排队输入保护，最终调用已有 closeIfIdle。下一次发送沿原生 session ID 懒恢复，不改 Terminal Codex 回收策略、插件批准或持久数据。

Pi watcher 16 项通过（单文件 1.92 秒），Session.close 47 项通过（2.36 秒）。在既有 watcher 文件加入一项内存 SQLite 集成用例，实际执行生产候选谓词和活动时间表达式，覆盖插件隐藏任务与受保护来源，以及三种时间字段更新后的排除；原有测试只注入假候选，无法发现 SQL 筛选错误。无新增文件、真实等待或逐例模块加载。此次不声称已完成真实 Pi 进程三十分钟闲置后的端到端恢复验证。

Desktop 完整类型检查为 223 条诊断（此前 224），本批接线无新增诊断；test-hygiene 通过（349 files within baseline）。完整 CI、主干冲突和其他类型迁移仍未完成，在线 VPS 未修改。

### 伙伴本机连接读取与主人范围（2026-11-01）

Desktop maker-host 补回 bootstrap 已调用的 setBotConversationConnectionsReader；共享 botCapabilityService 在主人可读范围内返回本机连接分配与历史检索说明。读取器每次访问当前账号存储，返回前复核 owner 与群授权；访客自查不调用读取器、不返回连接字段。Terminal 尚未注入读取器时返回 connectionsAvailable=false，不将空列表解释为已确认无连接。不新增历史归属推断或跨电脑查询权限。

沿用 botCanonicalSession 的真实 SQLite／生产服务回归，增加 available、unavailable、owner-changed 三个输入，并在既有群自查用例中验证读取器未调用。最小失败输入为具有连接的当前主人，旧共享服务不返回连接投影；切账号输入在 await 期间改变 owner，必须不返回 state。此 database integration 巨型文件的导入成本超过五秒预算，定向 16 passed、592 skipped，42.02 秒（收集 40.49 秒，执行 974ms），无新增文件、逐例模块重载或真实等待。默认 TEMP 首次执行触发 Windows 短路径 libuv 崩溃，仅将测试 TEMP/TMP 改为同一目录长路径后完成；未将崩溃运行计为通过。

app-runtime 类型检查通过；Desktop 完整检查 220 条诊断（此前 223），本批服务、接线及测试无诊断。PR 实时状态仍为草稿、CONFLICTING，仅 DCO 检查通过，完整 CI 未运行；不能据本轮定向测试宣称可合并。在线 VPS 未修改。

### 通知身份、当前状态与图片摘要（2026-11-01）

共享通知服务补回错误／待回复的身份读取，只读取伙伴身份与头像，不再读取上一轮回答，也不使用“有新回复”替代当前错误／待回复状态。Desktop 头像解析与身份读取共用一秒等待上限；超时仍交付通用通知，保留账号复核和完成通知去重。图片摘要通过现有 locale key 翻译。自主运行宿主类型仅要求实际读取的四个数据端口，不再强制未使用的 readBotDirectory。

Desktop 群聊通知展示入口从主干迁回，保留主群可见抑制、话题例外、600ms 头像预算和点击前 owner 复核；群聊生产端 onChatMessageNotification／onChatGroupAttention 尚未接回，因此仅完成展示适配，不能声称群聊通知链已恢复。

既有 notificationService、sessionNotificationPreview、sessionNotificationCopy 三文件 78 项全部通过（9.02 秒），未修改断言或增加测试文件。Terminal 真实持久化通知与代输入隐私回归定向 1 passed、124 skipped（41.80 秒，收集 39.07 秒、执行 2.34 秒），使用长路径 TEMP/TMP。app-runtime、Terminal 类型检查通过；Desktop 完整检查 218 条诊断（此前 220），本批文件无诊断；test-hygiene 通过（349 files within baseline）。主干冲突、完整 CI、夜间学习及群聊生产端迁移仍未完成，PR 保持草稿，在线 VPS 未修改。

### 群聊原生通知生产链（2026-11-01）

Chat Server 的 message.created 接入共享通知消费者，Desktop 注入上一批的原生展示入口。消费者从主干迁入 app-runtime，Desktop 原路径保留转发；以服务器精确序号、读位、静音、关注／点名和隐藏状态判断，异步摘要完成后再次校验连接及群代次。每次连接的首次快照建立静默基线，重放历史不弹窗；停止宿主时清理等待队列。Terminal 未注入原生展示端，不额外发云推送。灵动岛群聊未读提示及其通知分流尚未迁入，本批只完成原生通知链，不声称实际 OS 横幅或手机云推送送达已验证。

在既有 chatServer 测试加入真实生产 transport 回归：最小输入是已订阅群收到一条新的 message.created，之前共享适配器不通知。覆盖首次历史、重连历史、实时消息、已读／静音及切账号；使用模拟 HTTP／WebSocket 和 fake timers，属于 unit transport tier，无真实等待或新增测试文件。修改前源码运行时新增用例失败；修改后定向 1 passed、366 skipped（7.66 秒，收集 7.19 秒、执行 43ms），存量巨型文件导入超过五秒预算。既有消费者文件补入摘要生成期间读位变化的竞态，5 项全部通过，单文件 458ms。

两文件完整运行 335 passed、37 failed（9.03 秒）；用 HEAD 的 chatServer 原生产源码对照为 329 passed、38 failed（仅 Chat Server 文件），失败名称集合比较仅新增通知用例由失败转通过，其余 37 项完全一致。失败涉及分工自动继续、个人资料投影、私聊等尚未迁入的主干行为，未删改断言。app-runtime、Terminal 类型检查通过；Desktop 仍 218 条诊断，本批通知接线无新增诊断；test-hygiene 通过。主干冲突、完整 CI 与剩余迁移仍待解决，在线 VPS 未修改。

### 群聊执行与通知深链兼容（2026-11-01）

接回群聊运行时迁移遗漏的四项行为：讨论安排的较早回答限制为 600 字、最新回答保留至 2000 字；负责人安排未完成时同步拒绝新消息（`PLAN_OPEN`）；默认负责人投影为本机伙伴 ID；通知深链显式标注 `conversationKind: 'direct'` 后可读取直接会话、发送回复和推进读位。直接会话即使已预热，普通群入口仍只读快照并拒绝读取群消息或安排。

既有 `chatServer.test.ts` 定向运行 367 项通过（9.53 秒，收集 6.89 秒、执行 2.08 秒）；用例覆盖旧回答截断、安排期间拒绝新消息、负责人 ID 投影、直接通知读取／回复／已读，以及预热直接会话仍拒绝普通群入口。`@cindy/app-runtime`、`@cindy/companion-core`、`@cindy/remote-agent` 与 `cindy-terminal` 类型检查通过；`git diff --check` 通过。Desktop 整包类型检查已执行但失败，报告仍有多处跨模块接口迁移差异；本轮未运行完整 Desktop CI，PR 仍与主干冲突并保持草稿，本轮未部署或修改 VPS。

### 固定精简基线的启动超时修复（2026-11-02）

用户暂停上游整合，基于 `eabb350e74` 在独立工作区继续验证，保留 Codex、Claude Code、Pi。Linux 的任务标签重启持久化与锁定 vault 恢复测试均复现 5 秒超时。临时分段测量确认：请求只需毫秒、关闭约几十毫秒，启动中的 `EngineManager.allStatus()` 却消耗约 3 秒；它为只需要可执行路径的宿主启动额外执行三个引擎的 `--version`，重启时再次执行。临时诊断已移除。

启动改用现有 `resolve()` 解析全部三种引擎，保持 managed/PATH 查找顺序；显式引擎列表、刷新和安装仍沿用原有版本检查。没有关闭引擎、改变登录、vault 加密、持久化格式或远程协议。故障范围为当前 Terminal 服务初始化；不重建设备连接或重放用户请求。

回归并入已有 `host.integration.test.ts` 的真实服务重启用例：临时 PATH 中三个可执行 fixture 记录执行，断言启动和重启不执行引擎，同时标签仍持久化，显式列表返回三种引擎路径和版本并触发查询。旧实现先因出现执行记录失败；修复后通过，不改原 Linux 5 秒限制。测试属于原有 integration tier，无新增文件、真实等待或逐例模块重载。Windows 实跑还暴露 `.cmd` 入口的既有重复转义：`nativeCommand` 已为 cmd.exe 构造命令，Node 又添加反斜杠引号，导致版本查询返回 null。仅对 Windows cmd/bat 入口启用 `windowsVerbatimArguments`，保留原有参数校验、环境隔离与无 shell 模式；真实临时 cmd fixture 验证失败转通过。

验证：Linux 宿主整文件 19 passed、1 Windows 专用 skipped，44.75 秒（收集 37.06 秒、执行 7.17 秒）；此前两项分别 552ms 和 1038ms。Windows 定向宿主与引擎用例 10 passed、24 未执行，47.64 秒（收集 41.16 秒、执行 5.74 秒）；两项宿主分别 3517ms 和 2155ms。Linux 引擎管理全文件 14 passed，2.76 秒。存量宿主集成文件的模块收集超过单测预算，未通过增加 timeout 掩盖。Terminal 类型检查（Linux 启动修复、Windows 最终版本）、test-hygiene（349 files within baseline）和 diff 检查通过。

中国大陆版构建与独立包的原生依赖、help/version、五种 PTY 断线退出及后台存活 smoke 通过；实际供应商和在线 VPS 尚未验收。本轮没有重新运行此前三引擎的全部真实模型 fixture，也没有恢复上游合并或声称完整 CI 通过。

### 固定精简版 VPS 实机验收（2026-11-02）

上述最终中国大陆版 Linux x64 包已经本机中转部署到 Debian VPS，SHA256 为 `880210633e3dd568ec01c93cf758c29b803da2b9bc16defc9125b8b57ccca441`。升级前通过宿主安全停止入口确认无运行任务，保留旧程序及仅存服务器的私有 profile 备份。新旧包的 181 个数据库迁移文件逐文件相同。systemd user 服务、账号登录、vault 解锁和设备在线状态正常；未执行整机重启或回退演练。

Codex 0.159.2、Claude Code 2.1.296、Pi 1.0.2 均使用用户明确选择的同一自定义 Responses 供应商和模型。三种引擎首次固定回复、服务重启后原任务重复上次回复均通过，共六轮真实推理；三个原生线程标识哈希保持一致。Claude Code 的协议转换路径通过本次文本调用。凭据通过既有宿主配置入口在服务器内复用，没有进入本地工作区或报告。默认引擎仍为 Codex。

五分钟自动回收未通过：Codex 首轮结束约 301、323、352 秒时原进程仍在。宿主不忙，任务为普通 desktop 来源并有用户发送时间和原生线程；本轮尚未定位是计时还是资格判断问题。不能将真实线程恢复成功或先前虚拟计时测试解释为本次自动回收成功。

systemd 进程树三引擎同时保留时 PSS 约 1122 MiB、10 秒 CPU 窗口约单核 0.42%；重启续接后显式关闭本次三个测试运行时，只剩宿主 Node，PSS 约 580 MiB。后者紧随关闭操作的 CPU 窗口约 1.66%，不能代表稳定空闲。历史保留；不同进程组成的采样不能用于计算版本降幅。实际手机/桌面控制、真实工具与权限交互、长期资源观测、完整 CI 仍未验收，上游整合继续暂停。

### 正式插件装配下的 Codex 自动回收修复（2026-11-02）

上述五分钟回收失败已定位并修复。正式宿主通过 `TerminalPluginTasks` 给每个任务安装插件工具接口，普通任务也有 `task.plugin`；调度与实际回收却将其误当成插件拥有该任务，因此从未启动计时。删除这两处错误排除，继续使用已有 `row.source` 与生命周期字段判断归属；插件创建的任务仍排除，审批、队列、后台工作和专用运行时的保护保持。不修改插件沙箱、批准状态、权限或发现协议，Claude Code、Pi 的生命周期保持原样。

已有计时集成用例改为真实插件装配和 CLI 持久化输入队列；旧实现先红（回收调用为 0），修复后绿，并覆盖原线程冷恢复、排队时拒绝回收、插件来源排除和宿主关闭后取消计时。Windows 定向 6 passed、119 未执行，63.69 秒（收集 42.51 秒、测试 20.74 秒，计时用例 2427ms）；Linux 同组 6 passed、119 未执行，51.55 秒（收集 40.57 秒、测试 10.39 秒，计时用例 1793ms）。该存量集成文件加载真实 SQLite、MCP 与插件装配，未放宽超时。两端 Terminal 类型检查、test-hygiene（349 files within baseline）及 diff 检查通过。

大陆版 Linux x64 独立包构建和原生依赖/help/version smoke 通过；包 SHA256 为 `ae533fb687140042fd78bef4837fac0bb8c8b8a39644afb4ed339b52c52a2aa4`。包经本机中转上线并保留旧程序和停机数据备份，新旧迁移文件仍相同。真实供应商回复完成后未主动关闭或重启：286.1 秒原 Codex 仍在，301.1 秒采样已消失，符合五分钟计时；进程组 PSS 从 662.4 MiB 降至 507.9 MiB，差约 154.5 MiB。冷恢复到完整回复为 4.55 秒，旧进程已退出、原生线程标识保持、上次回复可正确重复。采样间隔 15 秒，不能将观测时刻当精确退出时刻。

验收后显式关闭本次恢复出的测试运行时并保留历史，最终只有宿主 Node，PSS 约 506 MiB、10 秒 CPU 窗口约单核 0.65%；不将短样本当作长期资源保证。账号、systemd 和三引擎供应商配置保持；Claude Code/Pi 的真实推理沿用上一轮结果，本轮未重复。源码尚未提交推送；上游整合、完整 CI、真实控制端与工具执行仍未完成。

### 三引擎工具与 Desktop 远控验收（2026-11-02）

Codex、Claude Code、Pi 均在 VPS 的独立测试目录执行 Python，读取随机输入、计算求和及 SHA256、写入结果，再通过 shell 或文件工具读回。独立脚本核验结果、cwd、UID 1001 与 Linux 平台，三者均返回 `TOOLS_OK`。实际工具分别为 Codex `exec`、Claude Code `Bash`/`Read`、Pi `bash`/`read`。Pi 与 Claude Code 的 Bash 请求经核对后逐次批准，未更改全局权限；Claude 首条命令有引号错误，收到执行错误后自行修正并完成。测试驱动已区分 CLI 的 `waiting` 与引擎失败，并以持久化完成标记核验结果。

本机 Desktop 0.1.121 中国大陆版通过界面向 VPS 的既有 Claude Code 测试任务发送固定回复请求，界面收到 `DESKTOP_VPS_OK_20261102`。VPS 历史同时确认原输入、来自本机 Desktop 的来源元数据、对应输入的完成回复；不是仅用 SSH 模拟远程控制。真实手机仍未验证。

工具测试还发现 CLI `waitForTurn` 只要读到 assistant 行就返回完成，Codex 的工具前 commentary 因而被误当最终结果。修复排除 commentary/流式行，优先采用 `turnCompleted`，缺少完成元数据的旧宿主仅在空闲时采用兼容结果；保持原有请求关联、排队、错误和审批入口，不重发消息、不扩大超时或改变 wire 协议。

回归并入已有 `tasks/host.test.ts`，通过真实队列与 SQLite 历史，验证 commentary 后仍等待、已有完成标记时即使宿主忙碌也能返回正确最终回复。旧代码先红（错误返回 completed），修复后通过。Windows 同组 4 passed、122 未运行，55.45 秒，其中新增用例 1776ms；Linux 同组 4 passed、122 未运行，43.71 秒，其中新增用例 469ms。存量集成文件模块收集约 38–44 秒，未放宽超时。两端 Terminal 类型检查、test-hygiene（349 files within baseline）、文档合同 10 项、diff 检查和 Linux 独立包构建 smoke 通过。

修复包 SHA256 为 `faa147cbb6523cc9067ed54bf80c60b0eaed1f9fb33413534ae98c253ceeb7dc`，已于北京时间 05:06:55 经本机中转部署；升级前确认宿主空闲并走安全停止入口，旧程序及停机 profile 备份仅留 VPS，新旧 181 个数据库迁移文件相同。账号、vault 和设备连接正常。新 CLI 再次向原 Codex 测试任务发送“先报告进度、执行工具、最后固定回复”，实际产生一条 commentary 和一次工具调用，CLI 等到完成才返回纯 `WAIT_FINAL_OK`，约 9.02 秒（含 CLI 与历史核验）。本次没有重跑五分钟回收实测、完整 CI 或恢复上游整合，源码仍未提交推送。

收尾仅关闭本次四个测试运行时并保留历史。最终服务在线、空闲，进程组只剩 Node，PSS 约 510.1 MiB；10 秒 CPU 窗口约单核 0.66%，不代表长时间稳定资源占用。三引擎工具、Desktop 远控已验证；手机控制、整机重启自启动、长时资源观测与回退演练仍未验证。

### Node 轻量常驻原型（2026-11-02）

新增独立 opt-in 的 lite-resident / lite-execution / lite-executor 与构建脚本。常驻进程保留认证、原 Device Link relay、本地 CLI socket 和有界只读缓存；原 TerminalService 与三引擎放入按需 fork 的执行进程，距最近唤醒或非只读请求至少30秒，且已无运行、审批、排队工作后刷新缓存并正常退出。缓存缺失会重新加载原宿主，写操作清缓存；只读 UNSUPPORTED_CHANNEL 做负缓存，避免 Desktop 轮询反复唤醒。父进程唯一写 vault，子进程沿用只读加密凭据库；短期 access token 走本机私有 IPC，不传 refresh token。默认正式服务入口不切换，数据库 migration、服务端与远程 wire 协议未改。

VPS 实测统计整个原型 systemd cgroup 的 smaps_rollup，单位 MiB：初始历史读取后 PSS/RSS 为81.68/84.21，Codex 后88.08/90.60，Claude Code 后89.37/91.90，Pi 后91.16/93.69，最终重复采样仍为91.16/93.69。每项都只剩同一个常驻 Node、executorPid=null、online、busy=false，且保留实际 Desktop 控制端连接；未强制 GC、限制内存或每项重启常驻。最终两次十秒 CPU 样本约单核0.0087%和0.0092%；Claude 的2.24%窗口包含回收收尾，不代表稳定空闲。运行峰值未测，100 MiB目标仅指回收后的空闲常驻。本次结果暂不触发 Go 替换方案，不能保证长期运行或任意历史规模都低于目标。

三引擎均在既有专用测试目录真实执行 Python 读取 result.json、打印 nonce_sha256，并分别返回 LITE_CODEX_OK / LITE_CLAUDE_CODE_OK / LITE_PI_OK；对应历史确认工具记录、turnCompleted=true和无待批请求。Claude 首次因 MODEL_CONFIGURATION_CHANGED 留在队列，经原有 retry-last-error 重试同一 clientId 后完成，未重复新增输入；具体竞态来源仍待定位，不能称三种冷启动均一次成功。Codex 冷启动至完成约12.60秒；Pi约13.23秒到权限等待，二者并非纯启动时间或可直接比较的完成耗时。权限仅逐次批准已核对测试命令。

实际 Desktop 的 messages:view（7次）与 history:query（4次）等读取没有渠道失败记录。另经本地 CLI 复读已缓存 Pi 历史，读取到本轮完成回复，执行进程累计启动数保持4且前后均为空，验证冷态缓存不唤醒。此项不能代替 Desktop UI；本轮截图黑屏，未完成原型可视验收。旧宿主不支持的 sidebar aliases 仍返回明确错误，不伪装成功。

真实 fork/IPC 回归并入既有 host.integration.test.ts，覆盖回收后读取、写后失效、忙碌拒绝关闭、撤权和不支持渠道负缓存。Windows最终定向1项通过（执行131ms，总43.47秒），Linux最终1项通过（执行100ms，总36.40秒，收集35.80秒）；已有巨型集成文件导入成本超过五秒预算，无新增测试文件或放宽timeout。Windows原有启动、标签持久化、锁定vault三项通过（51.46秒）；两端Terminal类型检查、Linux原型构建、test-hygiene349文件和diff检查通过，未运行完整CI。

验收overlay包SHA256：f416e98a1384ed011a05fb3483f9858aac486470838a7d952afee004414b407f。完成后已安全停止临时原型并恢复turnwait稳定服务，确认active、online、busy=false、prototype=null；当前VPS并非低于100 MiB的原型服务。临时unit正常退出后被systemd --collect移除，脚本多余stop返回code5，确认无原型进程后单独启动稳定unit完成恢复。凭据和profile备份仅留VPS，测试历史保留，源码未提交推送。

原型只验同账号远控、历史与按需执行。登录切换、配置写入、跨账号分享及调度/IM/主动伙伴/插件后台生命周期不构成完整生产支持；外部文件变更、异常退出、缓存一致性与更多控制端的长时资源稳定性仍待验证。先解决冷启动配置竞态和缓存/异常退出边界，再考虑正式替换；不恢复上游整合，不把原型结果解释为完整生产版本验收。
