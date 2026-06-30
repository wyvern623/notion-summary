# notion-summarizer

Notion のページが更新されると、その内容を自動で要約して Slack に投稿する Bot です。

旧構成では Cloud Run + Cloud Tasks で動作していましたが、Cloudflare Workers ベースの構成へ移行予定です。

## 概要

このBotは、Notion のページ更新イベントを受け取り、対象ページの本文を取得してAIで要約し、Slackの指定チャンネルへ投稿します。

主な流れは以下です。

```txt
[Notion でページ編集]
      │
      ▼
[Notion Webhook]
      │
      ▼
[Cloudflare Worker]
      │
      ├─ Webhook検証
      ├─ 対象ページの確認
      ├─ Notion本文の取得
      ├─ AIによる要約
      └─ Slack投稿
      ▼
[Slack の要約チャンネル]
```

## アーキテクチャ方針

Cloudflare Workers 上で動作させることを前提にします。

Webhook受信後、すぐに重い処理をすべて実行するのではなく、必要に応じて非同期処理に分離します。

想定する処理は以下です。

1. Notion Webhookを受信する
2. Webhookの検証を行う
3. 対象ページIDを取得する
4. Notion APIでページ本文を取得する
5. 本文を要約しやすい形式に変換する
6. AI APIで要約を生成する
7. Slackに投稿する

## デバウンス方針

Notion のページ更新は、編集中に複数回発火する可能性があります。

そのため、ページ更新直後にすぐ要約するのではなく、一定時間待ってから要約する方針です。

目的は以下です。

* 編集途中のページを要約しない
* 同じページに対する要約を何度も投稿しない
* 最終更新に近い内容だけをSlackに投稿する

具体的な待機時間や実装方法は、今後の設計で決定します。

## 重複投稿防止

同じページ更新に対して、Slackへ同じ要約を複数回投稿しないようにします。

少なくとも以下を使って重複判定する想定です。

* Notion page id
* last_edited_time
* イベント種別

具体的な保存先や実装方法は、今後の設計で決定します。

## Notion インテグレーション

1. Notion のインテグレーションページで内部インテグレーションを作成する
2. Internal Integration Token を取得する
3. 要約対象のページまたはデータベースに、そのインテグレーションを接続する
4. Webhook の送信先に Worker のURLを設定する

購読するイベント候補：

* `page.content_updated`
* `page.created`

## Slack アプリ

Slack Appを作成し、Bot Tokenを取得します。

必要なBot Token Scopesの候補：

* `chat:write`
* `channels:read`

プライベートチャンネルに投稿する場合は、追加スコープが必要になる可能性があります。

要約投稿先のチャンネルにはBotを招待します。

```txt
/invite @your-bot-name
```

Socket Mode は使用しません。

## 環境変数

主な環境変数は以下です。

| 変数                         | 説明                    |
| -------------------------- | --------------------- |
| `SLACK_BOT_TOKEN`          | Slack BotのOAuthトークン   |
| `SLACK_SUMMARY_CHANNEL_ID` | 要約投稿先チャンネルID          |
| `NOTION_API_TOKEN`         | Notionインテグレーショントークン   |
| `NOTION_WEBHOOK_TOKEN`     | Notion Webhook検証用トークン |
| `NOTION_DATABASE_ID`       | 対象DBを限定する場合に指定        |
| `NOTION_EVENT_TYPES`       | 要約対象のNotionイベント種別     |
| `GEMINI_API_KEY`           | Gemini APIキー          |
| `GEMINI_MODEL`             | 使用するGeminiモデル         |
| `SUMMARY_DELAY_SECONDS`    | 要約までの待機秒数             |

本番環境では、APIキーやトークンをコードに直書きせず、Cloudflare Workers のSecretsとして管理します。

## Notion本文取得

Notionの本文取得では、以下を考慮します。

* ブロック取得のページネーション
* 子ブロック
* 空ページ
* 権限不足
* 削除済みページ
* 長いページ本文

取得したブロックは、AIに渡しやすいテキスト形式に変換します。

## 要約フォーマット

Slackには、以下のような形式で投稿する想定です。

```md
*Notionページが更新されました*

*タイトル*
<ページタイトル>

*要約*
- 要点1
- 要点2
- 要点3

*詳細*
<NotionページURL>
```

最終的なフォーマットは、運用しながら調整します。

## エラー処理

以下のエラーを想定します。

* Webhook検証失敗
* 不正なイベント
* Notion API失敗
* Notion本文取得失敗
* AI API失敗
* Slack投稿失敗
* 保存処理失敗

Slack投稿に失敗した場合は、処理済みとして扱わない方針です。

## 技術スタック

* **Runtime**: Cloudflare Workers
* **Notion**: Notion REST API
* **Slack**: Slack Web API
* **AI**: Google Gemini API

その他の構成要素は、今後の設計で決定します。

## 旧Cloud Run版からの主な変更点

| 旧構成                | 新構成                |
| ------------------ | ------------------ |
| Cloud Run          | Cloudflare Workers |
| Cloud Tasks        | 未定                 |
| Python / Flask     | 未定                 |
| `/tasks/summarize` | 未定                 |

## 開発方針

* 仕様書を優先する
* 小さい単位で実装する
* いきなり大きな設計変更をしない
* APIキーやトークンをコードに直書きしない
* 秘密情報をログに出さない
* Notion本文を丸ごとログに出さない
* Slackへの二重投稿を防ぐ
* 外部API失敗時の挙動を考慮する
* 本番デプロイ前に十分に検証する

## 開発

### セットアップ

```bash
npm install
cp .dev.vars.example .dev.vars   # 実値を記入 (.dev.vars はコミットしない)
```

### コマンド

```bash
npm run dev        # wrangler dev (ローカル起動)
npm run lint       # Biome (lint + format チェック)
npm run lint:fix   # Biome 自動修正
npm run typecheck  # tsc --noEmit
npm test           # Vitest (外部APIはモック)
```

### アーキテクチャ (無料構成)

Cloudflare Queues は Workers Paid プラン必須のため、本実装では **Queues を使わず Cron Trigger + D1 ポーリング**で遅延実行を実現している(**Workers Free で動作**)。

```txt
[Notion Webhook] → [Worker fetch] → D1 page_state を pending + debounce_until 記録
[Cron Trigger 毎分] → [Worker scheduled] → debounce_until を過ぎた pending ページを D1 から取得 → 要約 → Slack
```

- デバウンス: Webhook は `debounce_until = 受信時刻 + SUMMARY_DELAY_SECONDS` を記録するだけ。Cron がその時刻を過ぎたページだけ処理する。
- 再試行: Queue の自動リトライの代わりに D1 `retry_count` を使い、失敗時は `pending` に戻して次の Cron tick で再処理。`SUMMARY_MAX_RETRIES` 到達で `failed`。
- 同時実行排他: `page_state.lock_until` の processing lock(TTL 120秒)。

### 初回 Cloudflare セットアップ

```bash
npx wrangler d1 create notion-summarizer-db          # 出力された database_id を wrangler.toml に設定
npx wrangler d1 migrations apply notion-summarizer-db --remote   # 本番D1へスキーマ適用
# (ローカル dev 用にスキーマを入れる場合は --local)

npx wrangler secret put NOTION_API_TOKEN
npx wrangler secret put NOTION_WEBHOOK_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SUMMARY_CHANNEL_ID

npx wrangler deploy   # Cron Trigger も自動登録される
```

Queue の作成は不要(Cron 構成のため)。詳細な仕様は [docs/spec.md](docs/spec.md) を参照(spec は Queues 版を記載。本実装は Cron 版に置換)。

### ディレクトリ構成

```txt
src/
  index.ts              # Worker entrypoint (fetch ルーティング + scheduled/Cron)
  config.ts             # env からの設定読み込み・デフォルト適用
  types.ts              # 共有型 (Env など)
  db.ts                 # D1 リポジトリ (page_state / summary_jobs / lock / getDuePages)
  markdown.ts           # Notion ブロック → Markdown 変換
  handlers/
    webhook.ts          # POST /notion/webhook (pending を D1 に記録)
    consumer.ts         # Cron 駆動の要約処理 (processDuePages)
  services/
    notion.ts           # Notion API クライアント
    gemini.ts           # Gemini 要約
    slack.ts            # Slack 投稿
  utils/
    crypto.ts           # Webhook 署名検証 (HMAC-SHA256)
    logger.ts           # 構造化ログ
migrations/0001_init.sql  # D1 スキーマ
test/                     # Vitest (fetch / D1 をモック)
```

### 実装上の前提・判断

仕様書で明示されていない箇所は以下の判断で実装している (後から変更可能)。

* **Webhook 署名は fail-closed**: `NOTION_WEBHOOK_TOKEN` 未設定の通常イベントはスキップせず `500` を返す。署名検証は raw body に対して行う。初回 verification ハンドシェイクのみ未設定でも `200`。
* **Gemini は REST `generateContent`** を `fetch` で直接呼ぶ (SDK 不使用)。一時障害 (429/5xx) は再試行、モデル不可は既定モデルへフォールバック、fallback 不可は `要約生成エラー:` を返し Slack へ投稿せず `failed` 記録。
* **Slack の「カテゴリ」= 親 DB タイトル** (無ければ「未分類」)、「更新日時」= `last_edited_time` の JST 表記。
* **processing lock の TTL = 120 秒** (`src/index.ts` の定数)。
* **Slack はチャンネル単位で冪等化**: 投稿成功チャンネルを `page_state.slack_ts` (channel→ts JSON) に記録し、retry 時は未投稿チャンネルのみ送る。全チャンネル成功で `completed`。
* **retry は D1 `retry_count` で制御**: `SUMMARY_MAX_RETRIES` 未満なら `pending` に戻して次の Cron tick で再処理、上限到達で `failed`。
* **無料枠対策**: Workers Free の subrequest 上限(1実行50)に収めるため `NOTION_MAX_BLOCK_FETCHES=30`、1 tick の処理ページ数 `CRON_MAX_PAGES=3`。デバウンス精度は Cron の最小粒度=1分。

## License

Private
