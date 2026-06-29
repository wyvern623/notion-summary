# CLAUDE.md

このリポジトリでは、Claude Code を実装支援エージェントとして使用する。

Claude は、必ずこのファイルと仕様書を読んでから作業すること。

## Project Overview

このプロジェクトは、Notionページの更新を検知し、そのページ本文を取得してAIで要約し、Slackに投稿するBotである。

想定構成は Cloudflare Workers ベース。

主な処理は以下。

1. Notionページ更新イベントを受け取る
2. 対象ページを特定する
3. Notion APIでページ本文・ブロックを取得する
4. 本文を要約用テキストに変換する
5. AI APIで要約を生成する
6. Slackに投稿する
7. 処理済み状態を保存し、重複投稿を防ぐ

## Important Documents

作業前に必ず以下を読むこと。

* `docs/spec.md`
* `README.md`
* `package.json`
* `wrangler.toml`
* 既存のソースコード

仕様書のパスが違う場合は、リポジトリ内の仕様書を探して読むこと。

## Core Rule

いきなり実装しない。

作業開始時は、まず以下を出すこと。

1. 仕様の理解
2. 現在のリポジトリ構成の把握
3. 仕様と現状コードの差分
4. 変更対象ファイル
5. 実装ステップ
6. リスク
7. テスト方針

ユーザーが「実装して」と明示するまで、コード変更しないこと。

## Architecture Policy

Cloudflare Workers 上で動くことを前提にする。

長時間処理・失敗しやすい処理・外部APIを複数回呼ぶ処理は、同期処理に詰め込みすぎない。

必要に応じて以下を使い分ける。

* Workers: Webhook受信・軽量な制御
* Queues: Notion取得、AI要約、Slack投稿などの非同期処理
* KV: 軽量な重複排除・一時状態管理
* D1: 履歴・処理状態・エラー記録など構造化データ
* R2: 大きな本文・ログ・中間生成物を保存する必要がある場合

ただし、無料枠運用を優先するため、過剰な構成にしないこと。

## Implementation Rules

実装時は以下を守ること。

* 仕様書を最優先する
* 大きな変更を一気に入れない
* 小さい単位で実装する
* 既存の設計・命名・型定義に合わせる
* 秘密情報をコードに直書きしない
* APIキー、トークン、署名シークレットをログに出さない
* 本番デプロイはしない
* 不明点を勝手に都合よく解釈しすぎない
* 判断が必要な場合は、仮定を明記する
* セキュリティに関わる変更は理由を書く
* テストなしで完了扱いにしない

## Notion API Rules

Notion APIを扱うときは以下を必ず考慮する。

* ブロック取得にはページネーションがある
* 1ページ300ブロック程度の記事を想定する
* 子ブロックを持つブロックがある
* APIレート制限を考慮する
* 取得失敗時のリトライ方針を持つ
* ページ本文をAI要約に渡す前に、不要な情報を整形する
* 空ページ・権限不足・削除済みページを考慮する

## Slack Rules

Slack投稿では以下を守る。

* 同じNotionページ更新で二重投稿しない
* 投稿失敗時に処理済みにしない
* Slack APIエラーを握りつぶさない
* 投稿本文が長すぎる場合の分割・短縮を考慮する
* チャンネルIDやBot Tokenを直書きしない

## AI Summary Rules

AI要約処理では以下を守る。

* 長すぎる本文は分割・圧縮を検討する
* Notion本文をそのまま雑に投げない
* 要約フォーマットを固定する
* 失敗時のリトライ・エラー記録を考慮する
* プロンプトはコード内に散らばらせず、管理しやすい場所に置く
* 個人情報や機密情報を不用意にログへ出さない

## Duplicate Prevention

重複排除は重要。

最低限、以下のようなキーで処理済み判定を行う。

* Notion page id
* last edited time
* event id
* summary target version

同じページ更新が短時間に複数回来ても、Slackに同じ要約を何度も投稿しないこと。

## Error Handling

以下の失敗を個別に扱うこと。

* Webhook署名検証失敗
* 不正なリクエスト
* Notion API失敗
* Notionページ取得失敗
* ブロック取得途中の失敗
* AI API失敗
* Slack API失敗
* Queue処理失敗
* 保存処理失敗

エラーは原因が追える形で記録する。
ただし、秘密情報はログに出さない。

## Commands

作業後は可能な限り以下を実行する。

```bash
npm run lint
npm run typecheck
npm run test
```

存在しないコマンドがある場合は、`package.json` を確認し、代替コマンドを提案すること。

勝手に新しいツールチェーンへ移行しない。

## Testing Policy

少なくとも以下のテストを検討する。

* Webhook受信
* 署名検証
* 不正リクエスト
* Notionページ取得
* Notionブロックのページネーション
* 300ブロック程度の記事処理
* AI要約処理
* Slack投稿処理
* 重複排除
* エラー時の挙動
* Queue処理
* 環境変数未設定時の挙動

外部APIは直接叩かず、基本的にモックする。

## Files and Responsibility

責務は分ける。

例：

```txt
src/
  index.ts              # Worker entrypoint
  routes/               # Webhook routing
  services/
    notion.ts           # Notion API access
    slack.ts            # Slack API access
    summarizer.ts       # AI summary
  queues/               # Queue consumers
  repositories/         # KV/D1 access
  utils/                # common utilities
  types/                # shared types
```

ただし、既存構成がある場合はそれを優先する。

## Security Rules

以下は禁止。

* `.env` の中身を読む・表示する
* APIキーをコードに直書きする
* トークンをログに出す
* 署名検証を省略する
* 認証なしの管理エンドポイントを作る
* 本番環境へ勝手にデプロイする
* 破壊的なDB操作を勝手に実行する

## Before Editing Checklist

コード変更前に必ず確認する。

* 仕様書を読んだか
* 既存コードを読んだか
* 変更対象ファイルを把握したか
* 実装方針を説明したか
* リスクを挙げたか
* テスト方針を出したか
* ユーザーから実装許可を得たか

## Final Report Format

実装後は以下の形式で報告する。

```md
## 変更内容

## 変更ファイル

## 動作確認
- 実行したコマンド
- 結果

## テスト

## 残リスク

## 次にやるべきこと
```

## Review Focus

PRレビュー時は以下を重点的に見る。

* 仕様書とのズレ
* Cloudflare Workersの制約違反
* 同期処理が重すぎないか
* Queueに逃がすべき処理がないか
* Notion APIのページネーション漏れ
* Slack二重投稿リスク
* AI要約失敗時の扱い
* エラー処理不足
* 環境変数の扱い
* 秘密情報の漏洩リスク
* テスト不足
* 型の甘さ
* 責務分離の崩れ

## Working Style

Claude は実装担当であり、最終判断者ではない。

判断に迷う場合は、以下のように書くこと。

```md
## 判断が必要な点
- A案:
- B案:
- 推奨:
- 理由:
```

勝手に大きな設計変更をしない。
迷ったら、小さく安全な変更を優先する。
