> 2026-10-24 修订：每次派发先实时查询全部四家（含指定队员派发），不使用会话记录/旧缓存。Codex 使用 account/rateLimits/read；Claude 使用订阅额度实时接口；Gemini 每次 agy /usage；DeepSeek 查余额。失败为未知。下文早期缓存来源说明以本段为准。

# 调度协议 v1（2026-10-24）

调度中心（aio-hub）根据这份协议决定“这类活交给谁”。机器读的版本在 `protocol\hub\config.json` 的 `routing` 部分，两边要保持一致。

## 0. 利益冲突声明与“不偏袒”规则

这份协议由 Claude（Anthropic 的模型）起草，而 Claude 本身就是被调度的四方之一。为了避免偏袒，起草时遵守以下规则，以后修改也必须遵守：

1. **用户定的分工是底线**：写代码给 GPT 和 Claude；图像给 GPT；读文本、总结、优化内容给 Gemini；DeepSeek 只在订阅额度不足时顶班。联网查到的资料只能用来**细化和解释**，不能推翻这几条。
2. **只认可以核对的证据**，并标明来源等级：
   - 【独立】多家厂商同台、由第三方跑分（如 Vals AI、Artificial Analysis、LMArena）；
   - 【厂商】厂商自己公布，可能挑选对自己有利的测试；
   - 【社区】博客、汇总站、用户反馈，只作参考。
3. **差距小就算打平**：同一项测试里，差距小于 3 个百分点，或者不同来源结论相互矛盾，一律按打平处理，交给额度来决定，不排先后。
4. **打平时谁剩的额度多就派给谁**，让各家的额度尽量同步减少，而不是固定偏向某一家。剩余比例也完全相同时，派给**最近最久没被派过**的那一家（轮流），不按表格里的先后顺序。
5. **没有任何一类活只能交给 Claude。**
6. **定期复查**：模型更新很快，这张表每次有新模型发布、或者每个月复查一次；数据过时，就按打平处理。

## 1. 各家当前使用的模型（本机实际情况）

| agent | 订阅 | 当前默认模型 | 依据 |
|---|---|---|---|
| codex | ChatGPT Plus | GPT-6.1 Sol | Codex 界面显示 `GPT-6.1-Sol default` |
| claude | Claude Pro | 由 Claude Code 按订阅自动选择（Opus 5.5 / Sonnet 5.5） | 未单独核实当前默认是哪一个 |
| gemini | Gemini Pro（经 agy） | Gemini 4 Argon (Low) | agy 的 `settings.json` |
| deepseek | API 按量付费 | DSH 的 `deepseek-official` 默认模型 | 未单独核实具体型号 |

## 2. 证据摘要（2026-10-24 联网查询）

| 能力 | 查到的情况 | 等级 | 对调度的影响 |
|---|---|---|---|
| 写代码（SWE-bench Verified） | 前几名几乎并列：Claude Opus 5 为 97.0%，DeepSeek V4 Pro 为 96.4%，GPT-5.6 Sol 为 96.2%；有论文直接说这张榜已经“分不出”前几名 | 【独立】Vals AI，2026-09-01 | **打平** → codex 和 claude 按额度轮流 |
| 命令行 / 运维类任务（Terminal-Bench 4.0） | Claude Opus 5.5 为 65.15%，Sonnet 5.5 为 64.14%，GPT-6 Astra 为 59.60%。GPT-6.1 Sol 没有上榜；Gemini 4 Argon 只有厂商数据 57.4% | 【独立】Vals AI，2026-10-22 | 对 Codex 实际用的 GPT-6.1 Sol **没有同台数据** → 不据此排先后，仍按打平处理 |
| 长期、原创的工程任务（DeepSWE v1.1） | Gemini 4 Argon 77.9%；GPT-6.1 Sol 约 75.2% | 【厂商】 | 证据不独立 → 不改变“写代码给 codex/claude”，gemini 只做写代码的后备 |
| 长文本（超长上下文） | Gemini 4 Argon 在 GraphWalks 256K–1M 上得 84.2%，可输出 100 万 Token；独立的 AA-LCR 榜首不在我们这四家里 | 【厂商】为主 | 和用户的分工一致 → 读长文、总结交给 gemini |
| 视频 / 图表理解 | Gemini 4 Argon 在 LVBench 上 91.7%，GPT-6 Astra 87.5%，Claude Opus 5.5 83.7%（数据来自 Google 自己的对比表） | 【厂商】 | 交给 gemini，后备是 codex、claude（按额度） |
| 写作 / 润色 | EQ-Bench 写作榜各汇总站说法互相矛盾，Gemini 4 没上榜 | 【社区】 | 没有足够证据推翻用户的分工 → 交给 gemini |
| 事实准确性 | GPT-6.1 Sol 自报事实错误率从 11.4% 降到 7.7%；Opus 5.5 的事实准确率高于 Sonnet 5.5（66% 对 54%），但幻觉率也更高（59% 对 47%） | 【厂商】/【独立】 | 各家各有长短 → 不单独设一类 |
| 生成图片 | Codex 登录 ChatGPT 账号后，有内置的生图工具（需要开启 `image_generation` 功能）；生成一张图大约消耗 3–5 倍于文字回合的额度 | 【社区】（引述官方维护者在 GitHub 的回复） | 交给 codex；**本机还没实测**，验证前先标为“未验证” |
| 综合智力指数 | Artificial Analysis 的数据：Opus 5.5 为 58，Sonnet 5.5 为 56，Gemini 4 Argon 约 53，GPT-6.1 Sol 约 52 | 【独立】，但不同来源的版本不一致 | 只作参考；“通用”类按额度均衡，不按这个分数排 |
| 价格 | DeepSeek V4 系列每百万 Token 只要几毛到几美元，远低于另外三家的 API 价 | 【社区】汇总 | 符合“DeepSeek 顶班”的定位 |

## 3. 分类与派活顺序

“第一梯队”内部视为打平，**谁剩的额度多就派给谁**；第一梯队都不可用时，才轮到“后备”，同样按额度排；DeepSeek 永远排在最后。

| 类别（`category`） | 适用的活 | 第一梯队 | 后备 | 最后顶班 |
|---|---|---|---|---|
| `code` | 写代码、改 bug、重构、写测试、命令行和环境配置 | codex、claude | gemini | deepseek |
| `review` | 代码审查、方案审查 | codex、claude | gemini | deepseek |
| `image` | 生成图片 | codex | —（未验证前没有后备） | — |
| `longtext` | 读长文、长文档、整本资料的总结和提炼 | gemini | claude、codex | deepseek |
| `writing` | 润色、改写、文案、优化内容 | gemini | claude、codex | deepseek |
| `multimodal` | 看视频、看图片、看图表 | gemini | codex、claude | — |
| `research` | 查资料、整理信息 | gemini | codex、claude | deepseek |
| `general` | 其他 | codex、claude、gemini | — | deepseek |

## 4. 额度规则

- 每家只看**最紧的那个窗口**（5 小时或每周，取剩余比例较小的那个）。
- 剩余低于 **10%** 视为“额度不足”，跳过；全部不足时才轮到 DeepSeek，并受每日预算（10 元）约束。
- 读不到额度或数据太旧时，标为“未知”，**不当作额度不足**，排在有数据的同梯队成员之后。
- 派出去之后，如果对方报“额度用完 / 被限速”，调度中心把它标为不足，自动换下一位，最多换一次。
- 每次自动选人的理由（候选名单、各家剩余额度、为什么选它）都记进 `board\dispatches.jsonl`。

## 5. 来源

- Vals AI：[SWE-bench Verified](https://www.vals.ai/benchmarks/swebench)、[Terminal-Bench 4.0](https://www.vals.ai/benchmarks/terminal-bench-4)
- [Coding Agents Have Converged（arXiv 2609.17394）](https://arxiv.org/pdf/2609.17394)
- Artificial Analysis：[模型排行](https://artificialanalysis.ai/leaderboards/models)、[AA-LCR 长上下文推理](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning)
- Google：[Introducing Gemini 4 Argon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/)；[Gemini 4 Argon 跑分汇总](https://emergent.sh/learn/gemini-4-argon-benchmarks)
- OpenAI：[GPT-6.1 Sol 系统卡补充](https://cdn.openai.com/pdf/38e3efcf-545e-44cd-99ec-2b7eb395f4cc/oai_GPT_6_1_Sol.pdf)；[GPT-6.1 Sol 跑分汇总](https://emergent.sh/learn/gpt-6-1-sol-benchmarks)
- Anthropic 相关：[Sonnet 5.5 与 Opus 5.5 对比（The Decoder）](https://the-decoder.com/anthropics-claude-sonnet-5-5-nearly-matches-opus-5-5-on-benchmarks-while-costing-up-to-30-percent-less-per-task/)
- DeepSeek：[DeepSeek V4 规格与价格](https://www.morphllm.com/deepseek-v4)；[DeepSeek API 价格（2026 年 10 月）](https://benchlm.ai/deepseek/api-pricing)
- Codex 生图：[openai/codex#8758](https://github.com/openai/codex/issues/8758)
- 写作榜：[EQ-Bench Longform（Sophon 汇总）](https://sophon.at/evals/eqbench-longform-creative-writing)
- LMArena：[Arena（维基百科）](https://en.wikipedia.org/wiki/Arena_(AI_platform))
