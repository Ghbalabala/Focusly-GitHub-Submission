# Focusly 番茄时钟

Focusly 是一款本地优先的 Vue 3 单页应用，用于番茄专注、学习任务管理、每日打卡与学习数据复盘。默认不需要后端，打开即用；也可通过环境变量对接 RESTful Mock API。

## 已完成功能

- 高精度番茄钟：专注/休息自定义、开始、暂停、继续、重置和环形进度。
- Web Worker 使用绝对截止时间校准，切换标签页、系统休眠后不累积漂移。
- 计时运行状态本地持久化，刷新后可恢复；多标签页同步计时和业务数据。
- 动态页签标题、页内提示、可选系统通知与完成提示音。通知权限只在用户点击时申请。
- 任务全流程：新增、描述、标签、编辑、完成切换、单删、一键清空，并可选择当前专注任务。
- 专注完成后自动记录会话、任务与标签，同一会话 ID 幂等去重。
- 每日打卡：记录当日累计专注分钟，同一本地日期禁止重复打卡。
- 数据看板：近 7/30 天趋势、标签时长分布、累计时长、番茄数、打卡数和连续天数。
- CSV/JSON 数据导出；CSV 对用户文本做了公式注入防护。
- 亮色/暗色主题、响应式布局、键盘可达性、减少动效偏好支持。
- Web Audio 合成细雨、森林和深色噪音，启停使用淡入淡出，不需要额外音频资源。
- PWA Manifest 与 Service Worker：生产环境可安装，已访问的应用资源可离线使用。

## 开发环境

- Node.js `^20.19.0` 或 `>=22.12.0`
- npm 10+
- 现代桌面浏览器（Chrome、Edge、Firefox、Safari 近期版本）

```bash
npm install
npm run dev
```

启动后访问终端显示的本地地址。

## 可用命令

```bash
npm run dev        # 开发服务器
npm run typecheck  # Vue + TypeScript 严格类型检查
npm run test       # 计时/日期/统计纯函数测试
npm run build      # 类型检查 + 生产构建
npm run preview    # 本地预览 dist
npm run check      # 测试 + 完整生产构建
```

`npm run test` 使用 Node.js 内置测试器与 TypeScript 类型剔除功能，建议在 Node.js 22.12+ 运行。Node.js 20 用户仍可正常开发和构建应用。

## Mock API 配置

复制示例配置：

```bash
cp .env.example .env
```

```dotenv
VITE_API_BASE_URL=https://example.test/api
VITE_API_TIMEOUT=5000
```

- `VITE_API_BASE_URL` 留空：应用完全使用 LocalStorage，不发起远程请求。
- 配置地址：GET 优先尝试远程并同步本地缓存；写操作先落本地，再尽力同步远程，网络失败不回滚用户操作。
- Mock API 需使用统一返回格式：`{ "code": 200, "msg": "...", "data": ... }`。

主要路径：`/timer/config`、`/task/list`、`/task/add`、`/task/update`、`/task/delete`、`/clock/list`、`/clock/add`、`/stat/week`、`/stat/month`。完成专注会话增加了可选扩展路径 `/focus/session/list` 与 `/focus/session/add`；Mock 未提供时仍会保存在本地。

## 键盘快捷键

- `Space`：开始/暂停计时（输入框聚焦时不触发）
- `Ctrl/Cmd + N`：聚焦新任务输入框
- `Ctrl/Cmd + D`：执行今日打卡

## 数据与时间规则

- 专注会话保存秒数，打卡与图表展示分钟。
- 日期以浏览器本地时区的 `YYYY-MM-DD` 为准，避免东八区夜间记录被 UTC 归到前一天。
- 统计同时存在会话和打卡快照时，对同一天取较大值，不重复累加。
- 多标签会话在饼图中平分时长，保证饼图总量与实际专注时长一致。
- LocalStorage 无法被保证“永久”；应用不会主动清理，但用户清除浏览器数据时会一并删除。可定期导出 JSON 备份。

## 工程结构

```text
src/
├── api/                 # 数据类型、本地仓储和可选 Mock API 门面
├── components/          # 计时、任务、打卡、统计和白噪音组件
├── styles/              # 主题 token 与全局样式
├── utils/               # 计时状态、安全存储、日期与统计纯函数
└── workers/             # 绝对截止时间式 Web Worker
public/
├── manifest.webmanifest # PWA 元数据
└── sw.js                # 应用壳与已访问资源缓存
tests/                  # 计时和统计回归测试
```

## 项目验证

```bash
npm run check
```

该命令必须满足：全部测试通过、TypeScript 无错误、Vite 生产构建成功。PWA/Service Worker 只在生产构建中注册，可用 `npm run build && npm run preview` 验证安装与离线行为。
