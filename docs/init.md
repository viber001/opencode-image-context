# 任务：开发 OpenCode Persistent Vision Context 插件

请在当前项目目录下创建：

```text
~/.config/opencode/<新建的插件子目录>/
```

进入该子目录后执行：

```bash
git init
```

将整个插件作为一个独立 Git 项目开发，并在开发过程中持续提交 milestone commits。**不要自动 push 到任何远程仓库。**

目标是开发一个 **OpenCode V1 + V2 双兼容的插件**，用于解决 coding agent 使用 `read` 读取大量图片后，图片 base64 长期累积在主 session context 中，导致 request 体积过大、甚至触发 413，同时尽可能保留视觉上下文。

---

## 方案 1 / 方案 2 简要定义

### 方案 1：Vision Child 的图片历史窗口

Vision Child Session 自己保留图片上下文，但设置**图片 payload 字节预算 + 滞回式批量淘汰**。

* 未超过 `HIGH_WATERMARK`：不删除图片。
* 超过 `HIGH_WATERMARK`：一次性淘汰最老约 **2/3** 的图片，使总量降到 `LOW_WATERMARK`。
* 保留最新约 **1/3** 的图片，避免每轮移动窗口。
* 被淘汰的图片用文字占位符或合法的最小 PNG placeholder 替代。
* 图片淘汰应以实际 attachment 字节大小为主要依据，而不是简单按图片数量。
* 这样可以控制 Vision Child 的 context/request 体积，同时尽量保留最近的视觉上下文，并减少 prefix cache 被频繁破坏。

### 方案 2：Main Session 的持久化 Vision Child

Main Session 不长期保存 `read` 返回的图片 attachment。

当 `read` 得到图片时：

```text
Main Session
    │
    │ image attachment
    ▼
Persistent Vision Child
    │
    │ visual analysis
    ▼
Main Session
    │
    └── textual observation only
```

具体要求：

* 图片发送给与 Main Session 关联的持久化 Vision Child Session。
* Vision Child 保留自己的视觉上下文，可以理解、比较和追问之前读取过的图片。
* Main Session 只接收 Vision Child 返回的文字分析结果。
* 在 Main Session 后续 outbound request 中，已经路由给 Vision Child 的原始图片 attachment 必须被移除。
* Main Session 可以通过 `vision.ask` 或等价机制向原来的 Vision Child 继续提问。
* Vision Child 发生不可恢复错误时，可以创建新的 Vision Child，并通过持久化 textual memory 恢复已有的视觉知识。

这样 Main Session 的 context 不再随着图片数量线性膨胀，而 Vision Child 专门承担视觉上下文的保存与管理。

**方案 1 只作用于 Vision Child，不作用于 Main Session。**

---

## 一、核心设计

不要简单地对主 session 做历史图片窗口裁剪。

采用“双层视觉上下文”：

```text
                    Main Session
                         │
                    read image
                         │
                         ▼
              ┌─────────────────────┐
              │ Vision Session      │
              │ persistent child    │
              │                     │
              │ image A             │
              │ image B             │
              │ image C             │
              │ visual reasoning    │
              └──────────┬──────────┘
                         │
                    textual result
                         │
                         ▼
                    Main Session
```

### Main Session

主 session 使用**方案 2：自动视觉转述 / Vision Child Session**：

1. `read` 返回图片 attachment 时，插件捕获 attachment。
2. 不让图片 attachment 长期进入 main session。
3. 将图片送入一个与 main session 关联的、持久存在的 Vision Child Session。
4. Vision Child 对图片进行视觉分析。
5. 返回简洁但信息完整的文字观察结果。
6. Main Session 只收到文字结果。
7. 在发送给主模型的 messages 中，确保已经路由到 Vision Child 的原始图片 attachment 被移除。
8. Main Session 后续可以通过 `vision.ask` 类似的内部机制向同一个 Vision Child 继续询问。

目标效果：

```text
Main request:
    不包含历史 PNG base64
    只包含：
        text
        vision analysis
        vision observations
```

---

## 二、Vision Child Session

Vision Child 必须是真正的**持久化 OpenCode session**，而不是每次图片都新建一个一次性 LLM 请求。

同一个 main session 应默认对应一个 Vision Child：

```text
main session A
    └── vision session A

main session B
    └── vision session B
```

Vision Child 应保持自己的视觉上下文：

```text
image A
image B
image C
    ↓
vision reasoning
    ↓
later question about A/B/C
```

例如：

第一次：

```text
image A
```

Vision Child：

```text
A 是一个存在明显透视变形的矩形投影区域……
```

之后：

```text
image B
```

Vision Child 应能够结合 A 和 B：

```text
相比 A，B 中左边缘的位置发生了……
```

之后 Main Session 可以询问：

```text
检查刚才图片 A 和 B 的左边缘是否属于同一条物理边界。
```

该问题应发送给原来的 Vision Child，而不是重新建立一个新的视觉上下文。

---

# 三、Main Session 与 Vision Child 必须严格隔离

插件必须能够识别 session role：

```ts
type SessionRole = "main" | "vision"
```

或者等价机制。

对于：

```text
main session
```

执行：

```text
image → vision child
image attachment → 从 main request/history 中移除
```

对于：

```text
vision child session
```

**绝对不能再次把图片 strip 掉。**

否则会形成：

```text
main
  ↓
vision child
  ↓
context transform
  ↓
image 被再次删除
```

导致 Vision Child 根本看不到图片。

---

# 四、Vision Child 使用方案 1

Main Session 使用方案 2，但 Vision Child 自己允许使用方案 1。

原因：

Vision Child 的任务就是维护视觉上下文，因此它可以暂时保留图片；但如果图片长期累积，也可能导致 context/request 过大。

因此 Vision Child 必须实现一个**图片历史容量控制器**。

不要每一轮都移动窗口。

必须使用：

## 字节预算 + 滞回式批量淘汰

例如：

```text
IMAGE_HIGH_WATERMARK = configurable
IMAGE_LOW_WATERMARK  = configurable
```

当 Vision Child 当前图片总 payload：

```text
<= HIGH_WATERMARK
```

时：

```text
不删除任何图片
```

当：

```text
> HIGH_WATERMARK
```

时：

```text
一次性删除最老的大约 2/3 图片，
使剩余图片降到 LOW_WATERMARK 以下。
```

默认策略：

```text
删除 oldest 2/3
保留 newest 1/3
```

这里的“2/3”是批量淘汰策略，不要求精确数学比例；实现时应优先按照实际 attachment byte size 计算，使最终 payload 回落到 low watermark。

**不要每轮只删除一张图片。**

原因：

每次修改靠前历史都会造成 prefix cache divergence。

实测：

```text
稳定历史：
cache_read ≈ 32000
cache_write ≈ 200
cache hit ≈ 99%

每轮改写靠前旧内容：
cache_read ≈ 25728
cache_write ≈ 9705
cache hit ≈ 72%
```

因此必须采用：

```text
HIGH → 批量淘汰 → LOW
```

而不是：

```text
每轮稍微淘汰一点
```

---

# 五、图片淘汰后的占位符

当 Vision Child 中删除历史图片时，不要留下非法 attachment。

如果必须保留结构位置，应使用合法的小型 placeholder image 或纯文本占位符。

推荐优先使用文本：

```text
[image omitted: sha256=<hash>, mime=image/png, already analyzed]
```

如果 OpenCode 当前 message schema 要求 image part 必须存在，则使用合法的最小 base64 PNG，例如 1×1 PNG。

**禁止产生非法 base64。**

已经实测：

```text
非法 base64 placeholder
    ↓
provider
    ↓
HTTP 400
```

因此所有 image placeholder 必须是合法数据。

---

# 六、不要使用 OpenCode compaction hook

这是强制要求。

**不要注册：**

```text
experimental.session.compacting
```

也不要在 V2 中实现：

```text
session.hook("compaction")
```

原因是当前环境已经使用：

```text
opencode-acp
```

ACP 自己负责 context management / compression。

插件不能和 ACP 同时接管 main session compaction。

因此：

```text
Main Session
    ↓
ACP
    ↓
负责主 session context management

Vision Plugin
    ↓
只负责 image routing / vision session / image retention
```

Vision Plugin 不参与 compaction。

如果 Vision Child 使用 OpenCode 自己的正常 compaction，那是 OpenCode session 自己的生命周期，不由本插件 hook/intercept。

---

# 七、必须兼容 OpenCode V1 和 V2

不要试图让 V1 plugin API 直接运行在 V2。

采用：

```text
plugin/
├── core/
│   ├── VisionManager
│   ├── VisionSession
│   ├── ImageStore
│   ├── ImageRegistry
│   ├── MemoryStore
│   └── RetentionManager
│
├── v1/
│   └── plugin
│
├── v2/
│   └── plugin
│
└── tests/
```

Core 不依赖 V1/V2 API。

V1/V2 只提供 adapter。

---

# 八、OpenCode V1 adapter

当前已经实测：

```text
tool.execute.after
```

可以拿到：

```ts
output.attachments
```

其中：

```ts
attachment.url
```

是：

```text
data:image/png;base64,...
```

V1 adapter 使用：

```text
tool.execute.after
```

捕获 read 返回的 image attachment。

然后使用：

```text
experimental.chat.messages.transform
```

在 model request 发出前，从 Main Session 的 messages 中删除已经路由给 Vision Child 的图片。

注意：

## V1 messages.transform 必须原地修改

不要简单：

```ts
output.messages = newMessages
```

而应对原数组/其中的 parts 做 in-place mutation。

已经验证：

```text
原地修改
150 KB → 109 KB
```

能够实际改变 outbound request。

---

# 九、OpenCode V2 adapter

实现对应的 V2 API：

```text
ctx.tool.hook("execute.after")
```

以及：

```text
ctx.session.hook("context")
```

用于在 model dispatch 前对 Main Session 的上下文进行图片 attachment 过滤。

不要使用 V2 compaction hook。

Core 不得依赖这些 API。

---

# 十、Headroom 兼容

当前环境使用：

```text
OpenCode
    ↓
opencode-acp
    ↓
Headroom
    ↓
provider
```

插件不得依赖 Headroom 内部实现。

不要：

* 修改 Headroom
* 调用 Headroom API
* 假设 Headroom 是某个 provider
* 对 Headroom 的 cache tracker 做特殊处理

插件只负责在 OpenCode 层面：

```text
Main request
    ↓
remove historical image attachment
    ↓
textual vision result
```

Vision Child request 则正常包含图片：

```text
Vision Child
    ↓
image attachment
    ↓
Headroom
    ↓
vision-capable provider
```

因此：

```text
Main Session → Headroom → text only
Vision Child → Headroom → image context
```

两者天然隔离。

---

# 十一、ACP 兼容

当前环境使用：

```text
opencode-acp
```

插件必须：

1. 不接管 compaction。
2. 不修改 ACP 自己的 compression state。
3. 不假设 session 一定由 CLI 直接创建。
4. 使用 OpenCode session ID 作为 main/vision session 的关联键。
5. 尽量只使用公开 plugin/session API。
6. 不修改 OpenCode core。
7. 不修改 ACP。

需要测试：

```text
普通 OpenCode session
ACP session
```

两种情况下插件都能工作。

---

# 十二、Vision Session Registry

建立持久化 registry：

```json
{
  "mainSessionId": "xxx",
  "visionSessionId": "yyy",
  "role": "main"
}
```

或者等价的数据结构。

至少记录：

```text
main session ID
vision session ID
image hash
mime
size
first seen
last seen
image location
```

同一 main session 再次遇到同一 image 时：

```text
sha256(image bytes)
```

命中已有 image：

```text
不要无意义地重新上传同一图片
```

但如果用户明确要求重新分析，可以向已有 Vision Child 发新的问题。

---

# 十三、Vision Child 失败恢复

必须考虑 Vision Child 出错：

```text
context overflow
provider error
session corrupted
invalid image
vision model unavailable
session not found
```

当 Vision Child 不可恢复时：

```text
old vision session
    ↓
mark failed
    ↓
创建新的 vision session
    ↓
恢复 textual vision memory
    ↓
重新建立必要的视觉上下文
```

不要让 main session 因 Vision Child 失败而崩溃。

Main Session 应得到类似：

```text
[vision subsystem restarted]
[previous visual observations restored from memory]
```

然后继续工作。

---

# 十四、视觉 memory

为每个 main session 建立：

```text
vision-memory/
    <main-session-id>.json
    <main-session-id>.md
```

保存：

```text
image hash
image metadata
visual observations
important geometry
OCR
用户提出的问题
Vision Child 的关键结论
图片之间的关系
```

注意：

**memory 不是图片本身。**

memory 是 Vision Child 的文字知识，用于 child session 崩溃后的恢复。

原始图片可以单独保存到：

```text
images/
```

并通过 hash 引用。

---

# 十五、Main Session 的视觉接口

设计一个内部/插件 tool：

```text
vision.ask
```

或者等价名称。

目标调用形式：

```json
{
  "question": "确认刚才图片右下角的边缘是否连续"
}
```

Vision Manager 根据当前 main session 找到：

```text
mainSession → visionSession
```

然后把问题发送给对应 Vision Child。

返回：

```text
concise textual answer
```

不要把 Vision Child 的完整 conversation 注入 Main Session。

---

# 十六、Main Session 不应该看到 Vision Child 的图片历史

Main Session 最终应该类似：

```text
User:
分析这张投影仪照片。

Tool:
[vision]
Detected projected rectangle.
Top edge ...
Left edge ...
Perspective ...
```

而不是：

```text
Tool:
image/png base64 ...
```

后续 request 也不能再次带出原始 image attachment。

这是本项目最核心的验收条件之一。

---

# 十七、Vision Child 可以看到自己的图片历史

例如：

```text
Vision Child:

image A
image B
image C

question:
compare A and C
```

request 中可以存在这些图片。

只有超过：

```text
HIGH_WATERMARK
```

之后才触发：

```text
oldest ~2/3 removal
```

并保留最新约 1/3。

---

# 十八、配置

提供合理默认值，并允许配置：

```json
{
  "vision": {
    "enabled": true,
    "model": "...",
    "maxImageBytes": 104857600,
    "highWatermarkBytes": 67108864,
    "lowWatermarkBytes": 33554432,
    "evictionRatio": 0.66,
    "keepRecentImages": 20
  }
}
```

具体配置格式应遵循 OpenCode 当前 V1/V2 plugin 的实际能力，不要为了配置而引入不必要的新机制。

不要硬编码 provider/model。

Vision model 应允许使用独立模型。

---

# 十九、测试必须真实运行

不要只写代码不验证。

至少建立：

```text
unit tests
integration tests
manual test script
```

必须真实验证以下情况：

### Test 1：普通 read 图片

```text
read image
```

确认：

```text
tool.execute.after
    ↓
Vision Child
```

确实收到图片。

---

### Test 2：Main Session request

确认：

```text
Main outbound request
```

没有原始 image attachment/base64。

---

### Test 3：Vision Child request

确认：

```text
Vision Child outbound request
```

确实包含图片。

---

### Test 4：连续读取多个图片

例如：

```text
image A
image B
image C
image D
```

确认：

```text
Main:
    没有 A/B/C/D 的 base64

Vision:
    有 A/B/C/D
```

---

### Test 5：Vision Child 继续提问

```text
read A
read B
vision.ask("比较 A 和 B")
```

确认 Vision Child 能利用历史视觉上下文回答。

---

### Test 6：Vision retention

人为设置非常小的：

```text
highWatermark
lowWatermark
```

验证：

```text
超过 HIGH
    ↓
一次性淘汰 oldest ~2/3
    ↓
剩余 newest ~1/3
```

确认不是每轮删一张。

---

### Test 7：非法 placeholder

测试淘汰后的 message：

```text
必须能正常发送
不能出现 HTTP 400
```

如果使用 placeholder image，验证其 base64 合法。

---

### Test 8：cache 行为

记录：

```text
prompt_tokens
cached_tokens
cache_read
cache_write
request body size
```

确认：

* Main Session 图片不会累积；
* Vision Child 允许缓存自己的图片上下文；
* Main Session 不因为每轮动态窗口裁剪而产生不必要的 cache miss；
* Vision Child 只在 watermark 触发时批量淘汰。

---

### Test 9：ACP

通过当前：

```text
opencode-acp
```

运行测试。

确认：

```text
ACP 正常
main session 正常
vision child 正常
```

特别确认没有：

```text
compaction hook conflict
```

---

### Test 10：Headroom

通过当前 Headroom 环境运行。

分别记录：

```text
Main request body size
Vision request body size
Headroom observed body size
```

确认：

```text
Main → no historical image payload
Vision → image payload remains
```

不要修改 Headroom。

---

### Test 11：Vision Child 故障恢复

模拟 Vision Child：

```text
invalid session
```

或等价故障。

确认：

```text
自动创建新 Vision Child
恢复 textual memory
Main Session 继续工作
```

---

### Test 12：V1

在当前 OpenCode V1 环境真实运行。

---

### Test 13：V2

如果当前环境同时可安装/运行 V2，则真实运行 V2。

如果当前机器无法同时安装 V2，不要伪造测试结果；建立兼容性测试代码，并明确记录：

```text
V1: tested
V2: static/API compatibility only
```

---

# 二十、日志

提供 debug 日志，例如：

```text
[vision] main=session_x image=sha256:abc routed to vision=session_y
[vision] stripped attachment from main session
[vision] vision session retained image=sha256:abc
[vision] image budget 72MB > high watermark 64MB
[vision] evicting oldest 8/12 images
[vision] retained newest 4 images
[vision] vision session=session_y failed
[vision] creating replacement session=session_z
```

日志中：

**绝对不要打印完整 base64。**

最多打印：

```text
mime
byte size
sha256
```

---

# 二十一、代码质量要求

要求：

* TypeScript
* strict mode
* 清晰模块边界
* V1/V2 adapter 与 core 解耦
* 不修改 OpenCode core
* 不修改 ACP
* 不修改 Headroom
* 不注册 compaction hook
* 不产生 provider-specific hack
* 错误必须可恢复
* 所有外部 session/tool 调用都要处理失败情况
* 不把整个图片 base64 写入普通日志
* 不把整个图片 base64 写入 textual memory

---

# 二十二、Git 开发方式

创建 Git repository：

```bash
cd ~/.config/opencode/<plugin-directory>
git init
```

至少形成以下 milestone：

```text
commit 1:
  scaffold + core interfaces

commit 2:
  V1 image interception

commit 3:
  persistent vision session

commit 4:
  main-session image stripping

commit 5:
  vision image retention / watermark eviction

commit 6:
  image hash + memory

commit 7:
  failure recovery

commit 8:
  V1 integration tests

commit 9:
  V2 adapter

commit 10:
  V2 compatibility tests
```

实际开发过程中如果合理，可以调整 commit 粒度。

**不要 squash 掉这些 milestone。**

---

# 二十三、最终验收标准

完成后必须能够明确回答：

1. Main Session 的图片是否不再长期累积？
2. Vision Child 是否真正持久？
3. Main Session 能否继续询问 Vision Child？
4. Vision Child 是否能够比较历史图片？
5. Vision Child 图片过多时是否采用 HIGH/LOW watermark 批量淘汰？
6. 是否默认删除最老约 2/3、保留最新约 1/3？
7. 是否避免每轮移动图片窗口？
8. 是否完全没有使用 compaction hook？
9. 是否兼容 opencode-acp？
10. 是否兼容 Headroom？
11. V1 是否真实测试？
12. V2 是否实现独立 adapter？
13. V1/V2 是否共享 core？
14. Vision Child 崩溃后能否恢复？
15. 是否没有修改 OpenCode core？
16. 是否没有修改 ACP？
17. 是否没有修改 Headroom？
18. 是否没有在日志中泄露 base64？

最后输出：

```text
Architecture
Files
Configuration
How to install
How to run
V1 test result
V2 test result
ACP test result
Headroom test result
Cache observations
Known limitations
Git commits
```

如果某项没有真实测试，不要声称测试通过，要明确标记：

```text
NOT TESTED
```
