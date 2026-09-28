# dsh-personal

https://github.com/ChengqianHuang/dsh-personal · topic: `dsh-plugin`

个人助理 bundle：让 dsh 用自然语言记录/查询/回顾你的个人数据（**经历**——电影/书/专辑/展览等任意类别、项目日志、任务、博客、网站、想法、每日记录），全部落在一个 SQLite 文件（`~/.dsh/personal/personal.db`）里。LLM 只负责理解和总结，事实全部来自 SQLite，重启后依旧可查。

安装与使用见 dsh 用户文档 `docs/user/develop/basic/publish.md`。设计决策见 [DESIGN.md](DESIGN.md)。

## 安装（dsh 源码运行模式下）

本仓库 clone（或 link）到任意位置后，在 dsh 仓库根目录安装进 profile：

```sh
# 从本仓库的本地 clone 安装（link 模式，源码即生效）
pnpm dsh plugin --profile web add /path/to/dsh-personal
pnpm dsh --profile web --dump-config               # 验证出现 "# == dsh-personal" 层
pnpm dsh web                                       # 启动后直接对话
```

卸载：`pnpm dsh plugin --profile web remove dsh-personal`。

配置（可选，写进 profile 的 cordis.patch.yml 或由 bundle 默认值兜底）：

```yaml
- id: personal
  name: dsh-personal
  config:
    timezone: Asia/Shanghai     # 日期分桶时区，默认进程时区
    # databasePath: ~/.dsh/personal/personal.db
    # enableDailyReview: true
    # enableWeeklyReview: true
```

## 构建 / 测试

```sh
(cd dsh-personal && pnpm install --ignore-workspace --config.auto-install-peers=false)
(cd dsh-personal && pnpm exec tsdown)                    # 产出 lib/index.mjs
pnpm exec vitest run --config dsh-personal/vitest.config.ts
pnpm exec tsc -p dsh-personal/tsconfig.json --noEmit
```

修改源码后重新 `pnpm exec tsdown` 即可（profile 里是 link，指向本目录）。
类型检查读取 DSH 各依赖包的声明文件；首次运行前需先构建上层 DSH 仓库。

当前数据库 schema 版本为 4。旧 v1–v3 数据库无法直接打开；如不需要旧数据，移走或删除旧 `personal.db` 后再启动。插件不会自动删除数据库文件。

## 工具（22 个）

- 记录：`record_experience`（类别可新增，如 movie/book/album/exhibition）`create_project` `record_project_log` `create_task` `update_task` `complete_task` `create_blog_post` `update_blog_post` `create_idea` `record_daily_log` `register_website`
- 查询：`query_experiences` `query_tasks` `query_project_logs` `query_blog_posts` `query_websites` `search_personal_data`
- 纠错：`get_personal_record` `update_personal_record` `delete_personal_record`
- 回顾：`generate_daily_review` `generate_weekly_review`

用法示例：直接说「今天看了《灵媒》，7.5 分」「读了半本《失控》」「Forge 今天定位了中文错位问题」「周末检查博客证书」「我有哪些事情没做？」「本周回顾」。

## 关键词检索

`search_personal_data` 使用 Jieba 中文分词和 SQLite FTS5，跨八类记录按 BM25 相关性统一排序。标题、名称、域名默认比备注和正文权重更高；标签也参与检索。比如「博客证书」可以找到「检查博客的 HTTPS 证书」，「streaming 中文错位」可以组合中英文关键词。

- `text`：主题关键词。模型从问题中提取关键词，把时间和类型分别填进日期窗口与 `types`。
- `match`：默认 `all`，要求全部关键词；`any` 返回至少命中一个词的记录。
- `types`、`from`、`to`、`period`：按记录类型与日期过滤；项目、网站也使用创建日期过滤。
- `limit`：跨类型的总条数，默认 20，上限 200。返回 `{ terms, hits }`，每条 hit 包含 `type`、`score` 和完整 `row`，保持相关性顺序；分数只在本次查询内可比。同分时按日期倒序、类型、id 排列。
- `query_experiences` 的 `text` 和 `match` 使用同一检索引擎，还能组合类别、动作、日期和标签。不带 `text` 时仍按日期列出经历。

搜索索引只存在于连接的内存 TEMP 表中，不改变 v4 数据库格式。首次搜索从现有记录建立索引，本连接的写入、修改和删除通过 TEMP trigger 同步；其他连接提交变更后，下次搜索在一致的读取事务里重建。关闭连接会释放索引，重启后从数据库恢复。大量记录或频繁跨进程写入时，重建会增加首次搜索延迟。

权重可在插件配置中调整，均须为正的有限数：

```yaml
searchTitleWeight: 5
searchTagWeight: 3
searchBodyWeight: 1
```

这是词法检索，支持中文复合词的子词，但不保证任意字符片段或同义词匹配；「看展」与「参观展览」仍可能需要模型换关键词查询。没有向量检索或自动语义扩展。

## 修改与删除已有记录

直接说「刚才那部电影评分改成 8 分」「这条记重复了，删掉」「证书检查已经完成」「把那个想法关联到博客项目」。模型使用会话中的记录 id 或先查询定位；多个候选都符合时先询问，不用相关性排名代替用户选择。记录与查询结果显示 id，`get_personal_record` 按精确类型和 id 返回完整行及 `revision`。

`update_personal_record` 和 `delete_personal_record` 必须传入读取结果的 `expected_revision`。服务在 `BEGIN IMMEDIATE` 事务里核对内容指纹再写入；其他连接或工具已改动记录时拒绝操作，模型需重新读取并核对意图。指纹不是历史版本序号：内容完全恢复后可恢复同一指纹。任务和博客的专用修改工具，以及 `complete_task`，也要求该参数。`updateTask`、`completeTask` 和 `updateBlogPost` Service API 同样要求传入读取到的 revision。

修改使用行字段的 camelCase 名称，只提交需要改变的字段；省略保留原值，空字符串清空允许为空的文本，`[]` 清空标签。`null` 可清空评分、任务截止日期、可空项目/网站链接及任务来源字段。项目和网站引用使用已有精确 id；任务的 `sourceType` 与 `sourceId` 在修改时必须同时有值或同时为 null。任务进入 `DONE` 自动记录完成日期，再次标记完成保留原日期，改成其他状态则清空完成日期。经历的类别、动作、评分和发生日期沿用记录时的校验；id 和创建时间不可修改。相对截止日期可使用 `dueIn`，显式 `dueAt` 优先（包括 null）。

删除是永久删除，没有撤销入口。项目日志、任务、博客和想法的外键引用，以及任务中类型/id 精确匹配的来源引用，会阻止删除并返回引用记录列表。用户决定解除或重新关联这些引用后再删；不级联删除其他记录。只移除目标自身及其两端的显式 `relations`，整个操作失败时一起回滚。修改、删除和回滚同步到检索索引；schema 保持 v4，现有数据无需迁移。
