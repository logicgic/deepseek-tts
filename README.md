# DeepSeek 语音 API

将 DeepSeek 网页朗读封装为本机 API，支持原文朗读、对话朗读、音色选择、多轮续聊及 WAV 导出。
## 开源协议与声明
本项目仅用于技术交流、学术研究与个人学习验证，请勿用于非法用途。
本项目与官方应用无任何附属关系。

需要 **Node.js 24+**。在项目目录依次运行：

```sh
npm install
npm run login
npm start
```

首次在弹出的浏览器中手动登录，凭据保存到 `.auth/` 后浏览器自动关闭；登录失效时重新运行 `npm run login`。若缺少浏览器，先运行 `npx playwright install chromium`。

保持服务运行，在另一个终端进入项目目录使用：

```sh
# 查看可用音色及其 ID
npm run voices

# 朗读原文
npm run speak -- --text "你好，世界"

# 读取 UTF-8 文本文件，指定音色和输出路径
npm run speak -- --file input.txt --voice stella --out output/hello.wav

# 提问并朗读回答
npm run chat -- --text "用一句话介绍你自己"

# 续聊：替换为上一轮输出的会话 ID 和消息 ID
npm run chat -- --text "再详细一点" --session "会话ID" --parent 2
```

音频默认保存到 `output/`，并通过运行 API 的 Windows 电脑默认音频输出自动播放；对话还会保存 `.wav.txt` 回答和 `.wav.json` 续聊信息。`speak`、`chat` 均支持 `--text` / `--file`、`--voice`、`--out`、`--no-play`。省略音色时沿用当前值，指定音色会更新账号偏好。

只保存，不自动播放：`npm run speak -- --text "你好" --no-play`（`chat` 同样适用）。非 Windows 系统仍可生成和保存音频，但跳过自动播放。

API 地址：`http://127.0.0.1:8787`（仅本机）。POST 请求使用 `Content-Type: application/json`。

| 接口 | 用法 |
| --- | --- |
| `GET /health` | 检查服务状态 |
| `GET /auth/status` | 检查登录状态 |
| `GET /voices` | 获取音色列表 |
| `POST /tts` | `{"text":"你好","voice_id":"stella"}`，返回 WAV |
| `POST /chat/tts` | `{"prompt":"你好","response_format":"json"}`，返回回答、续聊 ID 和 Base64 WAV；省略 `response_format` 返回 WAV |

API 续聊需同时传入 `chat_session_id` 和上一轮的 `message_id`（作为 `parent_message_id`）。单次输入最多 5000 字符，超时 5 分钟；原文复述校验不一致会报错。同一账号只运行一个服务实例。

`POST /tts` 和 `POST /chat/tts` 均接受布尔参数 `play`，默认 `true`。例如 `{"text":"你好","play":false}` 只返回音频、不播放。播放使用 Windows 默认输出设备（音响或耳机），不弹出播放器；请求等待播放结束后返回，多个请求按顺序播放。播放失败仍返回生成的音频。响应头 `x-audio-playback` 表示 `played`、`disabled`、`unsupported` 或 `failed`；对话 JSON 响应还包含同名含义的 `playback` 字段。更新代码后需重启 API 服务生效。

测试：`npm test`，无需登录或连接 DeepSeek。

项目只保留登录、API 服务和命令行客户端三个运行入口。`src/service.mjs` 负责朗读与对话流程，HTTP、SSE、音频和计算挑战模块负责上游协议；`assets/sha3.wasm` 是计算挑战所需的运行资源，不依赖研究文档目录。
