# notion-summarizer Cloudflare Workers 版 仕様書

作成日: 2026-06-29

## 1. 概要

`notion-summarizer` は、Notion ページの更新を Webhook で受け取り、一定時間編集が止まった後にページ本文を Gemini で要約し、Slack の指定チャンネルへ投稿する Bot である。

Cloud Run / Cloud Tasks / Secret Manager による構成は廃止し、Cloudflare Workers / Cloudflare Queues / Cloudflare D1 / Workers Secrets を使って運用する。

重要な変更点は、Cloud Tasks の「遅延実行 + タスク名による重複排除」を、Cloudflare Queues の `delaySeconds` と D1 上の状態管理で置き換えることである。

---

## 2. 目的

- Notion 上で更新された技術文書や研究資料を、自動で短時間に把握できる要約へ変換する。
- Notion の編集イベントが連続して発生しても、最終更新から一定時間後に 1 回だけ要約する。
- Cloud Run の常時課金・コンテナ運用をやめ、Cloudflare Workers の無料枠を中心に低コストで運用する。
- 要約結果を Slack に集約し、研究室メンバーが更新内容を追いやすくする。
- Webhook 受付処理と要約処理を分離し、Notion API / Gemini API / Slack API の遅延や失敗に耐える。

---

## 3. 対象範囲

### 対象

- Notion の `page.content_updated` および `page.created` イベントをトリガーにした自動要約。
- Notion ページ本文の取得と Markdown 化。
- Gemini API による要約生成。
- Slack チャンネルへの要約投稿。
- Cloudflare Workers、Cloudflare Queues、Cloudflare D1、Workers Secrets を使った本番運用。
- D1 によるデバウンス、重複実行防止、実行履歴管理。

### 対象外

- Slack の `@メンション` による手動要約。
- esa 記事の取得および esa 更新通知の監視。
- Notion 以外のドキュメントソース。
- Slack からの対話的なコマンド操作。
- 添付 PDF / 画像 / 動画の本文解析。
- 高度な管理画面。

---

## 4. システム構成

```text
[Notion でページ編集]
      |
      | page.content_updated / page.created
      v
[Cloudflare Worker: POST /notion/webhook]
      |
      | 署名検証、対象イベント判定、ページ取得、D1更新
      v
[Cloudflare D1: page_state / summary_jobs]
      |
      | delaySeconds 付きでメッセージ投入
      v
[Cloudflare Queues: notion-summary-queue]
      |
      | SUMMARY_DELAY_SECONDS 後
      v
[Queue Consumer Worker]
      |
      | last_edited_time / D1状態比較、本文取得、Markdown 化
      v
[Gemini API で要約生成]
      |
      v
[Slack の要約チャンネルへ投稿]
      |
      v
[Cloudflare D1 に結果・失敗履歴を保存]
```

### Cloud Run 版からの置き換え

| Cloud Run 版 | Workers 版 |
|---|---|
| Cloud Run HTTP サービス | Cloudflare Worker |
| Cloud Tasks | Cloudflare Queues |
| Cloud Tasks のタスク名重複排除 | D1 の `page_state` / `summary_jobs` による冪等性管理 |
| Secret Manager | Workers Secrets |
| IAM | Cloudflare アカウント権限 + Wrangler secrets |
| `/tasks/summarize` HTTP endpoint | Queue Consumer handler |
| Docker / Gunicorn / Flask | TypeScript Worker / Hono など |

---

## 5. 主要コンポーネント

| コンポーネント | 実装例 | 役割 |
|---|---|---|
| Worker HTTP Handler | `src/index.ts` | Webhook 受信、ヘルスチェック、管理用エンドポイントを提供する |
| Queue Consumer | `src/queue.ts` | Queues から要約ジョブを受け取り、実行する |
| Notion クライアント | `src/notion.ts` | ページ情報、DB 情報、本文ブロックを取得し、本文を Markdown に変換する |
| Gemini クライアント | `src/gemini.ts` | ページ本文を指定プロンプトで要約する |
| Slack 通知 | `src/slack.ts` | 要約結果を Slack Block Kit 形式で投稿する |
| D1 リポジトリ | `src/db.ts` | デバウンス状態、ジョブ履歴、実行結果を保存する |
| Markdown 変換 | `src/markdown.ts` | Notion ブロックを要約用 Markdown に変換する |
| 設定 | `src/config.ts` | `env` bindings / vars / secrets から設定値を読み込む |

---

## 6. HTTP エンドポイント仕様

### `GET /`

ヘルスチェック用エンドポイント。

| 項目 | 内容 |
|---|---|
| レスポンス | `ok` |
| ステータス | `200` |

---

### `POST /notion/webhook`

Notion Webhook を受信する。

#### 入力

- リクエストボディ: Notion Webhook の JSON ペイロード。
- ヘッダ: `X-Notion-Signature`
  - `NOTION_WEBHOOK_TOKEN` が設定されている場合に検証する。
  - 期待値は `sha256=<HMAC-SHA256>` 形式。

#### 初回検証ハンドシェイク

ペイロードに `verification_token` が含まれる場合、署名検証より先にログへトークンを出力し、`200` を返す。

```json
{
  "ok": true
}
```

この値を `NOTION_WEBHOOK_TOKEN` として Workers Secret に設定する。

#### 通常イベント処理

1. JSON をパースする。
2. `verification_token` が含まれる場合は初回検証として処理する。
3. 署名を検証する。
4. `type` が `NOTION_EVENT_TYPES` に含まれるか確認する。
5. `entity.type` が `page` であるか確認する。
6. `entity.id` を page ID として取得する。
7. Notion API でページを取得する。
8. `NOTION_DATABASE_ID` が設定されている場合、親 DB が一致するページだけを対象にする。
9. ページの `last_edited_time` を取得する。
10. D1 の `page_state` を upsert する。
11. D1 の `summary_jobs` にイベント履歴を保存する。
12. Cloudflare Queues に `delaySeconds = SUMMARY_DELAY_SECONDS` で要約メッセージを投入する。
13. 即座に `200` を返す。

#### Queue メッセージ payload

```json
{
  "job_id": "uuid",
  "page_id": "Notion page id",
  "event_type": "page.content_updated",
  "last_edited_time": "2026-06-06T10:00:00.000Z",
  "queued_at": "2026-06-06T10:00:05.000Z"
}
```

#### 主なレスポンス

| 条件 | ステータス | レスポンス |
|---|---:|---|
| JSON 不正 | 400 | `{"error": "invalid json"}` |
| 署名不一致 | 401 | `{"error": "invalid signature"}` |
| 対象外イベント | 200 | `{"ok": true, "skipped": "event_type"}` |
| ページ以外 | 200 | `{"ok": true, "skipped": "non_page"}` |
| page ID なし | 200 | `{"ok": true, "skipped": "no_page_id"}` |
| ページ取得失敗 | 200 | `{"ok": true, "skipped": "page_fetch_failed"}` |
| 対象 DB 外 | 200 | `{"ok": true, "skipped": "other_database"}` |
| D1 更新失敗 | 500 | `{"error": "db_error"}` |
| Queue 投入失敗 | 500 | `{"error": "queue_error"}` |
| Queue 投入まで完了 | 200 | `{"ok": true}` |

---

## 7. Queue Consumer 仕様

Cloud Tasks 版の `/tasks/summarize` は廃止し、Cloudflare Queues の consumer handler で要約処理を実行する。

### 入力

Queue message の body:

```json
{
  "job_id": "uuid",
  "page_id": "Notion page id",
  "event_type": "page.content_updated",
  "last_edited_time": "2026-06-06T10:00:00.000Z",
  "queued_at": "2026-06-06T10:00:05.000Z"
}
```

### 処理

1. Queue message body を検証する。
2. `page_id` がない場合は失敗として ack する。
3. D1 の `page_state` を取得する。
4. `page_state.latest_last_edited_time` と payload の `last_edited_time` が異なる場合、古いジョブとしてスキップする。
5. 現在時刻が `debounce_until` より前の場合、残り秒数を `delaySeconds` に指定して再 Queue 投入する。
6. D1 上で processing lock を取得する。
7. lock 取得に失敗した場合、別 consumer が処理中とみなしスキップまたは短時間 delay で再投入する。
8. Notion API でページを再取得する。
9. 現在の `last_edited_time` を取得する。
10. payload / D1 の `last_edited_time` と現在値が異なる場合、より新しい編集ありとしてスキップする。
11. ページ本文ブロックを取得する。
12. ブロックを Markdown に変換する。
13. 本文が空の場合はスキップする。
14. ページタイトル、ページ URL、親 DB のタイトルを取得する。
15. Gemini で要約を生成する。
16. Slack に要約を投稿する。
17. D1 に `completed` として保存する。
18. Queue message を ack する。

### 主な処理結果

| 条件 | 処理 |
|---|---|
| page ID なし | `summary_jobs.status = failed` |
| 古い `last_edited_time` | `summary_jobs.status = skipped`, reason = `newer_edit` |
| debounce 中 | delay 付きで再 Queue 投入 |
| processing lock 取得失敗 | `skipped` または短時間 retry |
| ページ取得失敗 | retry 対象 |
| 本文が空 | `skipped`, reason = `empty_body` |
| Gemini 失敗 | 最大リトライ後 `failed` |
| Slack 投稿失敗 | 最大リトライ後 `failed` |
| 要約と投稿完了 | `completed` |

---

## 8. デバウンス仕様

Notion は編集中に複数回 Webhook を送る可能性があるため、最終更新から一定秒数待って要約する。

- 待機秒数は `SUMMARY_DELAY_SECONDS` で設定する。
- デフォルトは `600` 秒、つまり 10 分。
- Webhook 受信時点の `last_edited_time` を D1 と Queue payload に保存する。
- Cloudflare Queues には `delaySeconds = SUMMARY_DELAY_SECONDS` でメッセージを投入する。
- Cloudflare Queues には Cloud Tasks のようなタスク名ベースの重複排除がないため、D1 で冪等性を担保する。
- Queue Consumer 実行時に D1 の `latest_last_edited_time` と payload の `last_edited_time` が異なる場合、そのジョブは古い更新として要約しない。
- 同じ `page_id` に対する処理が同時実行されないよう、D1 の `lock_until` で processing lock を取る。

### デバウンス状態更新

Webhook 受信時:

```sql
INSERT INTO page_state (
  page_id,
  latest_last_edited_time,
  debounce_until,
  status,
  updated_at
)
VALUES (?, ?, ?, 'pending', ?)
ON CONFLICT(page_id) DO UPDATE SET
  latest_last_edited_time = excluded.latest_last_edited_time,
  debounce_until = excluded.debounce_until,
  status = 'pending',
  updated_at = excluded.updated_at;
```

Queue Consumer 実行時:

```text
payload.last_edited_time != page_state.latest_last_edited_time
→ newer_edit として skip

now < page_state.debounce_until
→ 残り秒数 delay で再 Queue

payload.last_edited_time == page_state.latest_last_edited_time
かつ now >= debounce_until
→ 要約実行
```

---

## 9. D1 データ設計

### `page_state`

ページ単位の最新状態とデバウンス状態を管理する。

```sql
CREATE TABLE page_state (
  page_id TEXT PRIMARY KEY,
  latest_last_edited_time TEXT NOT NULL,
  debounce_until TEXT NOT NULL,
  status TEXT NOT NULL, -- pending, processing, completed, failed, skipped
  lock_until TEXT,
  last_summarized_at TEXT,
  last_summary TEXT,
  slack_ts TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_page_state_status ON page_state(status);
CREATE INDEX idx_page_state_debounce_until ON page_state(debounce_until);
```

### `summary_jobs`

Webhook イベントおよび Queue 実行履歴を保存する。

```sql
CREATE TABLE summary_jobs (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_last_edited_time TEXT,
  status TEXT NOT NULL, -- queued, processing, completed, failed, skipped
  skipped_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_summary_jobs_page_id ON summary_jobs(page_id);
CREATE INDEX idx_summary_jobs_status ON summary_jobs(status);
CREATE INDEX idx_summary_jobs_created_at ON summary_jobs(created_at);
```

---

## 10. Notion 取得仕様

### ページ情報

Notion REST API で以下を取得する。

- ページオブジェクト。
- `last_edited_time`。
- ページ URL。
- ページタイトル。
- 親 DB ID。
- 親 DB のタイトル。

タイトルはページプロパティ内の `type == "title"` の値から抽出する。取得できない場合は `タイトルなし` を使う。

### 本文ブロック

`/blocks/{block_id}/children?page_size=100` を使って取得する。

- ページネーションに対応する。
- `has_more` が true の間、`next_cursor` で続きを取得する。
- 子ブロックを持つブロックは再帰取得する。
- `child_page` と `child_database` は子ブロック取得の対象外にする。

### Workers Free 前提の取得制限

Cloudflare Workers Free は 1 invocation あたりの subrequest 制限が厳しいため、Notion API を無制限に再帰取得しない。

推奨デフォルト:

| 設定 | デフォルト | 説明 |
|---|---:|---|
| `NOTION_PAGE_SIZE` | `100` | Notion block children の取得件数 |
| `NOTION_MAX_BLOCK_FETCHES` | `40` | Notion block children API の最大呼び出し回数 |
| `NOTION_MAX_BLOCKS` | `800` | 1回の要約で扱う最大ブロック数 |
| `NOTION_MAX_MARKDOWN_CHARS` | `30000` | Gemini に渡す Markdown 最大文字数 |

上限に達した場合は、本文末尾に以下を追加する。

```text
[本文が長いため、一部のブロックは省略されています]
```

この制限は雑に見えるが、無料Workersで全部取り切ろうとする方が危ない。ネストが深いNotionページは簡単にAPI回数が膨らむ。

### URL から page ID の抽出

Notion URL または ID 文字列から、末尾の 32 桁 16 進数を抽出し、`8-4-4-4-12` のダッシュ区切り ID に整形する。

---

## 11. Markdown 変換仕様

Notion ブロックは要約用に Markdown 文字列へ変換する。

| Notion ブロック | Markdown 変換 |
|---|---|
| `paragraph` | プレーンテキスト |
| `heading_1` | `# text` |
| `heading_2` | `## text` |
| `heading_3` | `### text` |
| `bulleted_list_item` | `- text` |
| `numbered_list_item` | `1. text`、連続する番号付きリスト内で採番 |
| `to_do` | `- [x] text` または `- [ ] text` |
| `toggle` | `- text` |
| `quote` | `> text` |
| `callout` | `> text` |
| `code` | fenced code block |
| `divider` | `---` |
| `child_page` | `- [ページ] title` |
| `child_database` | `- [データベース] title` |
| `image` / `file` / `video` / `pdf` / `embed` / `bookmark` | `[type: caption]` または `[type]` |
| その他 rich_text を持つブロック | プレーンテキスト |

子ブロックは深さに応じて半角スペース 2 個ずつインデントする。

---

## 12. 要約生成仕様

Gemini API を利用する。

- デフォルトモデルは `gemini-2.5-flash-lite`。
- `GEMINI_MODEL` が設定されていればそのモデルを使う。
- 指定モデルが `not found`、`deprecated`、`retired`、`unsupported` などの理由で失敗した場合、デフォルトモデルへフォールバックする。
- フォールバックにも失敗した場合、`要約生成エラー: ...` を要約本文として返す。
- Gemini API の呼び出しは Queue Consumer 側でのみ行う。
- Webhook 受付時には Gemini API を呼ばない。

### プロンプト方針

要約対象読者は「研究室に配属された学部生」。

要約では以下を重視する。

- 技術的詳細の保持。
- 新規性、貢献、従来技術との差分の明示。
- 重要な略語は初出時に正式名称を併記。
- 結論、行動項目、今後の課題の抽出。
- 原文の論理構成に沿った整理。
- 冒頭の挨拶や導入文は出力しない。

### 長さ

| 設定値 | 指示 |
|---|---|
| `short` | 3-5 文で簡潔に |
| `medium` | 10 文程度で要点を押さえる |
| `long` | 20 文以上で詳細に |

未指定または不正な値の場合は `medium` を使う。

### 形式

| 設定値 | 指示 |
|---|---|
| `bullet` | 箇条書き |
| `paragraph` | 段落形式 |

未指定または不正な値の場合は `bullet` を使う。

---

## 13. Slack 投稿仕様

要約結果は `SLACK_SUMMARY_CHANNEL_ID` に指定されたチャンネルへ投稿する。

- チャンネル ID はカンマ区切りで複数指定できる。
- チャンネル ID が未設定の場合、エラーログを出して投稿しない。
- 各チャンネルへの投稿失敗はログに記録し、他チャンネルへの投稿処理は継続する。

### 投稿内容

Slack Block Kit の payload を生成する。

- header: `要約: {title}`
  - タイトルは最大 140 文字。
- section fields:
  - カテゴリ。
  - 更新日時。
- divider。
- summary sections:
  - Gemini の要約本文。
  - Slack の section 文字数制限に収めるため 2800 文字単位で分割。
- context:
  - Notion ページへのリンク。

fallback text は最大 3000 文字に切り詰める。

### Markdown から Slack mrkdwn への変換

- Markdown 見出しは太字へ変換する。
- `- `、`* `、`+ ` の箇条書きは `• ` に変換する。
- fenced code block は維持する。
- `**bold**` は Slack の `*bold*` に変換する。
- `__italic__` は Slack の `_italic_` に変換する。
- `\1`、`\2` のような番号プレースホルダが含まれる場合、連番へ補正する。

---

## 14. 環境変数 / Secrets

### Workers vars

`wrangler.toml` / `wrangler.jsonc` の `[vars]` に置ける非機密値。

| 変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `NOTION_VERSION` | いいえ | `2022-06-28` | Notion API バージョン |
| `NOTION_DATABASE_ID` | いいえ | なし | 要約対象を特定 DB に限定する場合の DB ID |
| `NOTION_EVENT_TYPES` | いいえ | `page.content_updated,page.created` | 要約対象イベント |
| `SUMMARY_DELAY_SECONDS` | いいえ | `600` | 要約までの待機秒数 |
| `GEMINI_MODEL` | いいえ | `gemini-2.5-flash-lite` | 使用する Gemini モデル |
| `SUMMARY_LENGTH` | いいえ | `medium` | 要約の長さ |
| `SUMMARY_STYLE` | いいえ | `bullet` | 要約の形式 |
| `NOTION_PAGE_SIZE` | いいえ | `100` | block children 取得件数 |
| `NOTION_MAX_BLOCK_FETCHES` | いいえ | `40` | Notion block API 最大呼び出し回数 |
| `NOTION_MAX_BLOCKS` | いいえ | `800` | 最大ブロック数 |
| `NOTION_MAX_MARKDOWN_CHARS` | いいえ | `30000` | Gemini に渡す本文最大文字数 |
| `DEBUG_VERBOSE` | いいえ | `false` | 詳細デバッグフラグ |
| `LOG_LEVEL` | いいえ | `INFO` | ログレベル |

### Workers Secrets

`wrangler secret put` で設定する機密値。

| 変数 | 必須 | 説明 |
|---|---|---|
| `SLACK_BOT_TOKEN` | はい | Slack Bot の OAuth トークン |
| `SLACK_SUMMARY_CHANNEL_ID` | はい | 要約投稿先チャンネル ID。カンマ区切りで複数可 |
| `NOTION_API_TOKEN` | はい | Notion インテグレーショントークン |
| `NOTION_WEBHOOK_TOKEN` | 本番でははい | Notion Webhook 署名検証用トークン |
| `GEMINI_API_KEY` | はい | Gemini API キー |

### 廃止する環境変数

Cloudflare Workers 版では以下は使わない。

| 旧変数 | 理由 |
|---|---|
| `GCP_PROJECT_ID` | GCP を使わない |
| `CLOUD_TASKS_LOCATION` | Cloud Tasks を使わない |
| `CLOUD_TASKS_QUEUE` | Cloud Tasks を使わない |
| `TASK_TARGET_URL` | Queue Consumer を使うため HTTP task endpoint 不要 |
| `TASK_SHARED_SECRET` | Queue Consumer は外部公開しないため不要 |
| `CLOUD_TASKS_SERVICE_ACCOUNT` | GCP IAM / OIDC を使わない |

---

## 15. Cloudflare binding 仕様

### `wrangler.toml` 例

```toml
name = "notion-summarizer"
main = "src/index.ts"
compatibility_date = "2026-06-29"

[vars]
NOTION_VERSION = "2022-06-28"
NOTION_EVENT_TYPES = "page.content_updated,page.created"
SUMMARY_DELAY_SECONDS = "600"
GEMINI_MODEL = "gemini-2.5-flash-lite"
SUMMARY_LENGTH = "medium"
SUMMARY_STYLE = "bullet"
NOTION_PAGE_SIZE = "100"
NOTION_MAX_BLOCK_FETCHES = "40"
NOTION_MAX_BLOCKS = "800"
NOTION_MAX_MARKDOWN_CHARS = "30000"
LOG_LEVEL = "INFO"
DEBUG_VERBOSE = "false"

[[queues.producers]]
binding = "SUMMARY_QUEUE"
queue = "notion-summary-queue"

[[queues.consumers]]
queue = "notion-summary-queue"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3

[[d1_databases]]
binding = "DB"
database_name = "notion-summarizer-db"
database_id = "<cloudflare-d1-database-id>"
```

### binding 名

| binding | 種別 | 用途 |
|---|---|---|
| `SUMMARY_QUEUE` | Queue producer | Webhook 受付時に要約ジョブを投入する |
| `DB` | D1 database | デバウンス、実行履歴、要約結果を保存する |

---

## 16. セキュリティ仕様

### Notion Webhook

- `NOTION_WEBHOOK_TOKEN` が設定されている場合、`X-Notion-Signature` を HMAC-SHA256 で検証する。
- `NOTION_WEBHOOK_TOKEN` が未設定の場合、署名検証はスキップされる。
- 本番運用では `NOTION_WEBHOOK_TOKEN` の設定を必須とする。

### Queue Consumer

- Queue Consumer は外部 HTTP endpoint として公開しない。
- そのため、Cloud Tasks 版の `X-Tasks-Secret` は廃止する。
- Queue message body には API key や本文全文を含めない。
- Queue message には `page_id`、`last_edited_time`、`job_id` など最小限の情報だけを入れる。

### Secret 管理

本番では `.env` をコミットしない。以下は Workers Secrets で管理する。

- `SLACK_BOT_TOKEN`
- `SLACK_SUMMARY_CHANNEL_ID`
- `NOTION_API_TOKEN`
- `NOTION_WEBHOOK_TOKEN`
- `GEMINI_API_KEY`

### ログ

ログに出してよいもの:

- `job_id`
- `page_id`
- event type
- status
- skip reason
- API の status code

ログに出さないもの:

- Notion API token
- Slack token
- Gemini API key
- Notion ページ本文全文
- Gemini に渡した全文プロンプト

---

## 17. デプロイ仕様

本番は Cloudflare Workers で動作する。

- ランタイム: Cloudflare Workers
- 言語: TypeScript
- デプロイ: Wrangler
- キュー: Cloudflare Queues
- DB: Cloudflare D1
- Secrets: Workers Secrets
- Docker / Cloud Build / Artifact Registry は使わない。

### 初回セットアップ例

```bash
npm install

npx wrangler d1 create notion-summarizer-db
npx wrangler queues create notion-summary-queue

npx wrangler d1 migrations create notion-summarizer-db init
npx wrangler d1 migrations apply notion-summarizer-db

npx wrangler secret put NOTION_API_TOKEN
npx wrangler secret put NOTION_WEBHOOK_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SUMMARY_CHANNEL_ID

npx wrangler deploy
```

---

## 18. ローカル実行仕様

### 開発サーバ

```bash
npm install
npx wrangler dev
```

### ローカル Secrets

`.dev.vars` を使う。

```dotenv
NOTION_API_TOKEN="..."
NOTION_WEBHOOK_TOKEN="..."
GEMINI_API_KEY="..."
SLACK_BOT_TOKEN="..."
SLACK_SUMMARY_CHANNEL_ID="..."
```

`.dev.vars` は `.gitignore` に追加し、コミットしない。

### テスト

```bash
npm test
```

テストランナーは Vitest を想定する。

---

## 19. テストで確認する仕様

### Webhook

- 正常な Notion Webhook で D1 に `page_id` と `last_edited_time` が保存される。
- 正常な Notion Webhook で Queues に delay 付きメッセージが投入される。
- 不正な署名の Webhook は `401` になる。
- 対象外イベントは Queue 投入されない。
- 対象 DB 外のページは Queue 投入されない。

### Queue Consumer

- payload の `last_edited_time` が D1 の最新値と異なる場合、Slack 投稿しない。
- `debounce_until` より前に実行された場合、再 Queue 投入する。
- `last_edited_time` が一致し、debounce 済みなら Gemini 要約結果を Slack 投稿する。
- 同じ page ID のジョブが並行実行されても、processing lock により二重投稿しない。
- Gemini 失敗時は retry される。
- Slack 投稿失敗時は retry される。
- 最大リトライ超過時は `failed` として D1 に保存される。

### Markdown / Slack formatting

- Markdown 見出しを Slack mrkdwn の太字へ変換する。
- Markdown 箇条書きを Slack の bullet 表現へ変換する。
- code block を維持する。
- 長い要約を Slack section 用に分割する。
- Slack payload が header、section、context を含む。
- Notion ブロックの見出し、本文、箇条書き、番号付きリストを Markdown に変換する。
- Notion ページタイトルを title property から抽出する。

---

## 20. 既知の制約

- Cloudflare Queues は Cloud Tasks のタスク名重複排除と同じ機能を持たないため、D1 の状態管理が必須。
- Queue は重複配信される可能性がある前提で、必ず冪等に処理する。
- Workers Free は subrequest / CPU の制約があるため、Notion ブロックの完全再帰取得には上限を設ける。
- テーブルなどの特殊な Notion ブロックは詳細構造を完全には Markdown 化しない。
- Gemini API がエラーを返した場合、エラー文を Slack へ投稿せず、D1 に failed として記録する。
- Slack 投稿に失敗した場合、Queue retry の対象にする。
- Notion API の取得失敗は即スキップではなく、429 / 5xx は retry 対象にする。
- 24時間以上遅延させる運用は Cloudflare Queues Free 前提では避ける。

---

## 21. 運用確認ポイント

- `GET /` が `ok` を返すこと。
- Notion Webhook の初回検証時に `verification_token` を取得できること。
- `NOTION_WEBHOOK_TOKEN` 設定後、通常イベントで署名検証が成功すること。
- Webhook 受信後、D1 の `page_state` が更新されること。
- Webhook 受信後、Cloudflare Queues にメッセージが投入されること。
- `SUMMARY_DELAY_SECONDS` 経過後、対象ページの編集が止まっていれば Slack に投稿されること。
- 編集が続いている場合、古い Queue message が `newer_edit` でスキップされること。
- 同一ページに対する連続更新で Slack 投稿が1回にまとまること。
- D1 の `summary_jobs` で completed / failed / skipped の履歴を追えること。
- Workers Logs で Webhook 受信、Queue 投入、要約生成、Slack 投稿の流れを追えること。

---

## 22. 実装優先度

### Phase 1: MVP

- `GET /`
- `POST /notion/webhook`
- Notion 署名検証
- 対象イベント判定
- 対象 DB フィルタ
- D1 schema
- Queue 投入
- Queue Consumer
- Notion block 取得
- Markdown 変換
- Gemini 要約
- Slack 投稿
- D1 に completed / failed / skipped 保存

### Phase 2: 安定化

- 429 / 5xx retry
- Slack rate limit retry
- processing lock 強化
- 長文ページの省略通知
- failed job の再実行用 endpoint
- ログ整備

### Phase 3: 拡張

- 複数 DB ごとの Slack チャンネル振り分け
- 差分要約
- Notion への要約書き戻し
- 管理画面
- Workers Paid への移行判断
