# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![Docs](https://img.shields.io/badge/docs-docs.codeg.app-3451b2)](https://docs.codeg.app)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <strong>日本語</strong> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg（Code Generation）はマルチエージェント・コーディングワークスペースです。あらゆる AI コーディングエージェントをひとつの場所で動かし、そして協働させます。

対応するすべてのエージェント CLI のセッションを検索可能なワークスペースへ集約し、ひとつのタスクの中でメインエージェントが別種類のサブエージェントへ委譲できます。付きっきりで見ていたくない作業は ToDo タスクに書いておけば、それぞれが専用のブランチで無人のまま進み、あなたのレビューを待ってから取り込まれます。Codeg はデスクトップアプリ・スタンドアロンサーバー・Docker コンテナのいずれとしても動作し、ネイティブの iOS / Android クライアントもあるのでデスクを離れても作業を続けられます。エージェントは 15 種を内蔵し、ACP 互換の任意のエージェントを自分で登録することもできます。

![ワークスペース](../images/workspace-light.png#gh-light-mode-only)
![ワークスペース](../images/workspace-dark.png#gh-dark-mode-only)

## 📖 ドキュメント

**完全なドキュメントは [docs.codeg.app](https://docs.codeg.app)** — [はじめに](https://docs.codeg.app/getting-started/) · [ガイド](https://docs.codeg.app/guide/) · [リファレンス](https://docs.codeg.app/reference/)

## 💖 スポンサー

<table>
  <tr>
    <td align="center" width="220">
      <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg" target="_blank"><img src="../images/compshare.png" alt="Compshare" width="160" /></a><br/>
      <strong><a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">Compshare（UCloud）</a></strong>
    </td>
    <td>本プロジェクトをスポンサードしてくださった Compshare に感謝します！Compshare は UCloud 傘下の AI クラウドプラットフォームで、月額制・従量制のコストパフォーマンスに優れた国内モデル agent Plan プランを提供しており、月額 49 元から利用可能です。安定した公式リダイレクトによる海外モデルへのアクセスも提供しています。Claude Code、Codex、API 連携に対応。企業向けの高並列対応、7×24 テクニカルサポート、セルフ請求書発行をサポートしています。<a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">こちらのリンク</a>から登録された方には、5 元分の無料プラットフォームクレジットが進呈されます！</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://hezu.ink/sign-up?aff=0wVz" target="_blank"><img src="../images/hezu-ink.jpg" alt="合租巴士" width="200" /></a><br/>
      <strong><a href="https://hezu.ink/sign-up?aff=0wVz">合租巴士</a></strong>
    </td>
    <td>本プロジェクトをスポンサードしてくださった合租巴士に感謝します！合租巴士は、Codex や Claude Code などの主流モデルに高い安定性の中継機能を提供する、信頼性が高く効率的な AI 中継サービスプラットフォームです。チャージ比率は透明（1:1）で、Codex のレート補助は 0.08 から利用可能です。<a href="https://hezu.ink/sign-up?aff=0wVz">公式サイトからグループに参加すると $5 分の体験クレジットがもらえます</a>。</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://console.lqapi.xyz/sign-up?aff=KPy9" target="_blank"><img src="../images/lq-router.png" alt="LQ router" width="160" /></a><br/>
      <strong><a href="https://console.lqapi.xyz/sign-up?aff=KPy9">LQ router</a></strong>
    </td>
    <td>本プロジェクトをスポンサードしてくださった LQ router 中継サービスに感謝します！LQ router は、エンタープライズ級の AI 中継サービスを専門とし、企業や個人開発者に安定・高効率・低コストな AI モデル API の接続サービスを提供します。GPT、Claude、Grok、Gemini などの主要モデルに対応し、GPT Pro の課金倍率は最低 0.1 倍です。<a href="https://console.lqapi.xyz/sign-up?aff=KPy9">公式サイトからグループに参加すると $1 分の体験クレジットがもらえます</a>。</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://go.apimart.ai/gh-codeg" target="_blank"><img src="../images/apimart-ai.png" alt="APIMart" width="200" /></a><br/>
      <strong><a href="https://go.apimart.ai/gh-codeg">APIMart</a></strong>
    </td>
    <td>本プロジェクトをスポンサードしてくださった APIMart に感謝します！APIMart は AI 画像・動画生成に特化した低価格 API プラットフォームです。GPT-Image-2 は 1 枚 $0.006 から、1 ドルで 160 枚以上を生成できます。画像も動画も 1 つの非同期 API でカバー：タスクを送信して ID を受け取り、ポーリングまたはコールバックで結果を取得します。数万枚のバッチ処理でもタイムアウトせず、モデルを切り替えてもコードの変更は不要です。従量課金で月額費用は不要——<a href="https://go.apimart.ai/gh-codeg">こちらから登録</a>すればすぐに使い始められます。</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg" target="_blank"><img src="../images/astraflow.png" alt="UCloud ·星图AstraFlow" width="120" /></a><br/>
      <strong><a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a></strong>
    </td>
    <td>
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a><br/>
      UCloud の星図 AstraFlow 大規模モデルプラットフォームは、200 以上のモデルをワンクリックで呼び出せます。Kimi K3、DeepSeek V4/V3、Qwen 3、GLM5.2、happyhorse など世界トップクラスのオープンソース大規模モデルを内蔵しており、自前の学習は不要、すぐに使い始められます。<br/>
      上のリンクから<strong>メールアドレス</strong>で登録し、実名認証を完了すると<a href="https://f.howxm.com/xs/u/HVFW5X8EIYV1">50 元分の計算リソースクレジットを受け取れます</a>。
    </td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG" target="_blank"><img src="../images/fluxion-ai.png" alt="Fluxion AI" width="160" /></a><br/>
      <strong><a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">Fluxion AI</a></strong>
    </td>
    <td>本プロジェクトをスポンサードしてくださった Fluxion AI に感謝します！Fluxion AI は、統一されたひとつの API を通じて、GPT、Claude、Gemini をはじめとする主要な AI モデルへの高速・安定・低コストなアクセスを提供します。新規ユーザーは<a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">専用リンク</a>から登録すると $3 分の API クレジットを受け取れます。</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA" target="_blank"><img src="../images/beeapi.jpg" alt="BeeAPI" width="200" /></a><br/>
      <strong><a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a></strong>
    </td>
    <td>本プロジェクトをスポンサードしてくださった <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a> に感謝します！BeeAPI は、マルチモデル対応の AI API 中継・集約プラットフォームです。複数のサービスプロバイダーと主要な AI モデルを集約し、事業者間の価格比較、グループ単位のスマートルーティング、統一された API 接続と課金に対応しており、より柔軟・安定・低コストに AI サービスを呼び出せます。</td>
  </tr>
</table>

> Codeg のスポンサーになりませんか？[メールでお問い合わせください。](mailto:itpkcn@gmail.com)

## 🤖 対応エージェント

Claude Code · Codex · Gemini · OpenClaw · OpenCode · Cline · Hermes · CodeBuddy · Kimi Code · Pi · Grok · Cursor · DeepSeek Harness · Qoder · Google Antigravity

その多くは Codeg がインストール・バージョン固定・更新まで面倒を見ます。全リスト、各エージェントの実行環境要件、セッションの保存場所は [対応エージェント](https://docs.codeg.app/guide/supported-agents) を参照してください。

リストにない？自分で追加できます。公開されている ACP レジストリから選ぶか、distribution JSON を貼り付けるだけで、Codeg がインストールし、起動できるかを事前に確認し、あとは内蔵エージェントと同じように扱います — ピッカーに並び、`@` 委譲やスキルにも対応し、そのエージェント自身が履歴を残さない場合でも会話は記録され検索できます。→ [カスタムエージェント](https://docs.codeg.app/guide/custom-agents)

## 🤝 マルチエージェント協調

マルチエージェント協調は、キーひとつで完結します。`@` を打ち、エージェントを選び、送信するだけ。あとのスケジューリングは Codeg が引き受けます — 指名されたエージェントをそれぞれ独立したセッションとして起動し、タスクを引き渡し、その作業を今いるスレッドへ流し込みます。ふたつ指名すれば並走します。Claude Code が下書きし、Codex がレビューする。コンテキストの切り替えも、ターミナル間のコピー＆ペーストも不要です。

エージェントが自前のサブエージェントを立ち上げたとき — Claude Code も Codex も Grok も OpenCode もそうします — 子ごとにカードができ、終わってからまとめて出るのではなく、動いている間に中身が埋まっていきます。開けば子自身のセッションを読めます。

![ひとつの Codeg 会話からサブエージェントへタスクを委譲する様子](../images/collaboration-light.gif#gh-light-mode-only)
![ひとつの Codeg 会話からサブエージェントへタスクを委譲する様子](../images/collaboration-dark.gif#gh-dark-mode-only)

## ✅ ToDo タスク

すべての仕事に付き添う必要はありません。書き留めるだけ — タイトル、説明、どのエージェントで走らせるか — で、Codeg がそれに**コードの専用コピー**を渡します。プロジェクトの隣に作られる git worktree で、専用のブランチの上です。同時にいくつ走っても互いに触れず、あなたが作業中のツリーにも触れません。今夜に予約することも、フォルダーに同時実行数の上限までキューを自分で消化させることもできます。

終わったタスクが自分でマージすることはありません。レビュー列へ移って待ちます。diff を読み、もう一周やり直させ、あるいは受け入れる — すると取り込むのはエージェントで、まずベースブランチを自分の worktree に取り込み、そこでコンフリクトを解消します。そのあと Codeg はエージェントの言い分ではなく git を確かめます。確認できなかったマージは、成功と報告される代わりにレビューへ戻ります。

![ToDo タスクのボード。タスクが「ToDo」から「進行中」を経て「完了」へ進む](../images/task-light.png#gh-light-mode-only)
![ToDo タスクのボード。タスクが「ToDo」から「進行中」を経て「完了」へ進む](../images/task-dark.png#gh-dark-mode-only)

## 🪟 画面分割

タブ列がひとつでは足りないときもあります。会話タブを右クリックすれば、ビューを**右**または**下**へ、何度でも分割できます — 左右に 2 つ、縦に 3 つ、あるいは格子状に。どのグループもそれ自体がひとつのワークスペースで、独自のタブ、独自のヘッダー、独自の新規会話ボタンを持ちます。片方のペインで Claude Code にリファクタリングさせ、隣のペインで Codex に diff をレビューさせる、という具合です。

タブをグループ間でドラッグしても、そのセッションは移動中もストリーミングを続けます。グループの境界をドラッグすれば、スペースの分け方が変わります。レイアウトはワークスペースごとに、下書きも含めて記憶されます — Codeg を開き直せば分割はそのまま戻り、送らなかった文字も入力欄に残っています。

![会話エリアをタブグループの格子に分割する](../images/split-light.gif#gh-light-mode-only)
![会話エリアをタブグループの格子に分割する](../images/split-dark.gif#gh-dark-mode-only)

## 📄 Office ドキュメント

スライドでも、レポートでも、表計算でも、頼めばエージェントは本物の `.pptx` / `.docx` / `.xlsx` を作ります — 右側のペインがそれをリアルタイムに描画しながら。編集は自動でプレビューへ反映され、スライドが埋まり、表が形になり、数値がセルに収まっていきます。4 枚目が気に入らない？次のメッセージでそう伝えるだけ — エージェントは同じファイルをその場で直し、プレビューが追いつきます。書き出しも、外部の Office アプリも、Codeg を離れる必要もありません。

![ライブプレビューを横に置いて Office ドキュメントを編集するエージェント](../images/office-light.png#gh-light-mode-only)
![ライブプレビューを横に置いて Office ドキュメントを編集するエージェント](../images/office-dark.png#gh-dark-mode-only)

## 💻 ワークスペース

ワークスペースはひとつ、エージェントはすべて。動かしているのが Claude Code でも Codex でも Cursor でも、同じエディタ、同じライブ diff、同じ Git クライアントの中で作業します。そして生まれるのはリポジトリの中の本物のファイル — 目の前で変わっていきます。別のディレクトリを取り込むこともできます — 共有ライブラリ、隣のサービス、ドキュメントのリポジトリ — ファイルツリーも検索もエージェント自身も、それらをひとつのワークスペースとして扱います。

**セッション**：すでにある履歴をそのまま引き継げます。インストール済みのすべてのエージェントの過去セッションをワンクリックで取り込み、中断したところから再開できます。取り込んだ後は、もう互いに孤立したままではありません — 古いセッションを `@` で指名すれば、いま話しているエージェントがそれを読めます。別のエージェントが書いたものでも構いません。今日の Codex が、先週の Claude Code が終えたところから続けられます。セッションがどれだけ長くなっても、開くときはまず直近のラウンドを表示し、残りはさかのぼるにつれて読み込みます。

**ファイル**：エージェントの編集は、着地するそばから会話の隣に diff として現れます。どのファイルもシンタックスハイライト付きの本物のエディタで開け、`⌘L` でファイルを — あるいは選択範囲だけを — そのままエージェントへ渡せます。Markdown、HTML、画像、Office ドキュメントも同じペインでプレビューできます。

**Git**：状態表示ではなく、完全なクライアントです。「変更」タブからそのままコミットでき — メッセージを書いて Enter — その隣に pull、fetch、push、stash が並び、履歴はどのコミットが push 済みかを示します。ブランチ、マージ、リベース、リセット、別ブランチとの差分に加えて、切り替えずに任意のブランチを更新・push できます。コンフリクトは三ペインのマージエディタで開き、ハンク単位で採用するか自分で書きます。そして worktree は並行作業をワンアクションに変えます — 新しいブランチ、専用のディレクトリ、そこに根を張った新しい会話。エージェントの一隊が互いのファイルに触れることなく、別々の機能を同時に作れます。

**うまくいかないとき**：失敗したターンは「何かが起きました」で終わりません。Claude Code と Codex では種類まで示します — 接続の問題、アクセスの問題、上限到達、リクエスト拒否、サービスの問題 — そして入力欄の下に、本当に役立つものだけを載せた帯が出ます。再試行、サインイン、あるいは新しいセッション。エージェントが自分で再試行している間は琥珀色で表示され、ターンが無事に終われば「復旧しました」の一行に収まります。入力欄の下の接続インジケーターもボタンです。押せばそのセッションの本当の状態が分かり、やり直しではなく再開する「再接続」もそこにあります。

## 📱 iPhone・iPad・Android

デスクを離れても、作業は止まりません。ネイティブの iOS / Android クライアントは、あなたがすでに動かしている Codeg —— デスクトップアプリの **Web サービス**、あるいは自分で立てた `codeg-server` —— に接続します。そこからセッションを開始し、返信やツール呼び出しが流れ込むのを追い、権限の確認に答え、プロジェクトやブランチを見て回れます。端末側には何も移りません。ファイルもエージェント CLI も会話も Codeg を実行しているマシンに残り、アクセストークンは iOS Keychain または Android Keystore が預かります。どちらのクライアントもオープンソース（[iOS](https://github.com/xintaofei/codeg-ios)、[Android](https://github.com/xintaofei/codeg-android)）です。接続はわずか 3 ステップ、詳しくは [モバイルアプリ](https://docs.codeg.app/getting-started/installation#mobile-apps)。

| iPhone・iPad | Android |
| :---: | :---: |
| <img src="../images/mobile-ios.jpg" alt="Codeg iOS クライアントでセッションを開始する画面" width="248" /> | <img src="../images/mobile-android.jpg" alt="Codeg Android クライアントに流れ込むエージェントの返信" width="248" /> |

## ✨ ハイライト

- **[会話の集約](https://docs.codeg.app/guide/aggregation)** — 対応するすべてのエージェントのセッションを統一された検索可能なワークスペースへ取り込み、中断した続きから再開できます
- **[マルチエージェント協調](https://docs.codeg.app/guide/multi-agent)** — `@` でエージェントを指名するだけで委譲。異なる種類のサブエージェントがそれぞれ独立したセッションとして、ひとつのタスク内で並行して動きます
- **[ToDo タスク](https://docs.codeg.app/guide/tasks)** — やるべきことを書き留めればエージェントがキューを片づけていきます。各タスクは専用の worktree で走り、あなたがレビューして初めてブランチに取り込まれます
- **[カスタムエージェント](https://docs.codeg.app/guide/custom-agents)** — 公開レジストリまたは distribution JSON から、ACP 互換の任意のエージェントを登録。Codeg がインストールと履歴の記録を引き受け、内蔵エージェントと同じように扱います
- **[ワークスペース](https://docs.codeg.app/guide/workspace)** — エージェントの隣に開発の一連の流れがすべて揃います：ファイルツリー、エディタと diff、Git の変更、コミット、内蔵ターミナル、そして[ひとつのワークスペースにまとめた複数のフォルダー](https://docs.codeg.app/guide/workspace#work-across-several-folders)
- **[画面分割](https://docs.codeg.app/guide/workspace#split-the-conversation-view-into-groups)** — 会話エリアを好きな数のタブグループに分割し、タブや境界をドラッグして組み替え。再起動後もレイアウトは下書きごと復元します
- **[Git と Worktree](https://docs.codeg.app/guide/git)** — 変更のレビューとコミット、Git リモートアカウントの管理、内蔵の `git worktree` フローによる並行開発
- **[トークン使用量](https://docs.codeg.app/guide/token-usage)** — ステータスバーのカウンターの裏には完全なレポート：推移とキャッシュヒット率、アクティビティのヒートマップ、フォルダー・エージェント・モデル・セッション別の内訳
- **[チャットチャンネル](https://docs.codeg.app/guide/chat-channels)** — Telegram、Lark（飛書）、WeChat からエージェントを操作：タスク作成、権限の承認、進捗のリアルタイム受信
- **[オートメーション](https://docs.codeg.app/guide/automations)** — 設定済みの入力欄を再利用可能なオートメーションとして保存し、cron スケジュールまたは任意のタイミングでヘッドレス実行。セッションを開始することも、後であなたがレビューする ToDo タスクを積むこともできます
- **[Office ドキュメント](https://docs.codeg.app/guide/office)** — 同梱の `officecli` で `.docx` / `.xlsx` / `.pptx` を作成・分析・校正・編集し、タブ内でライブプレビュー
- **[科学研究](https://docs.codeg.app/guide/research)** — 同梱の研究スキル（仮説生成、実験計画、統計、可視化、批判的吟味、文献検索）をどのエージェントからも呼び出せます
- **[プロジェクトブート](https://docs.codeg.app/guide/project-boot)** — ライブプレビュー付きで新規プロジェクトを視覚的に構築し、そのままワークスペースで開きます
- **[MCP](https://docs.codeg.app/guide/mcp) & [スキル](https://docs.codeg.app/guide/skills)** — ローカルスキャンとレジストリ検索/インストール、スキルはグローバル／プロジェクト単位で管理
- **[自分の見た目に](https://docs.codeg.app/reference/settings/appearance)** — 12 のテーマをカラートークン単位で塗り替え、角丸をアプリ全体で設定し、テーマを shadcn JSON で読み書きし、必要なら自分で CSS を書けます
- **[デスクトップ・サーバー・Docker](https://docs.codeg.app/getting-started/deployment)** — ネイティブなデスクトップアプリ、ブラウザから使えるスタンドアロンの `codeg-server`、あるいは `docker compose up`
- **[iPhone・iPad・Android](https://docs.codeg.app/getting-started/installation#mobile-apps)** — デスクトップやサーバーに接続するネイティブモバイルクライアント：どこからでもセッションを開始し、返信をストリーミングで受け取り、権限を承認し、プロジェクトを閲覧

## 📦 インストールと実行

**デスクトップ** — macOS・Windows・Linux 向けインストーラーを [Releases](https://github.com/xintaofei/codeg/releases) から入手し、[インストール](https://docs.codeg.app/getting-started/installation) の手順に従ってください。

**サーバー** — Codeg をヘッドレスで動かし、任意のブラウザから利用します。Linux / macOS の場合：

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
CODEG_STATIC_DIR=/usr/local/share/codeg/web codeg-server
```

Windows（PowerShell）の場合：

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
$env:CODEG_STATIC_DIR="$env:LOCALAPPDATA\codeg\web"; codeg-server
```

**Docker** — 同じサーバーを、ひとつのコンテナで：

```bash
docker run -d -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

**モバイル** — [iOS アプリ](https://apps.apple.com/app/codeg-client/id6785199071) または [Android APK](https://github.com/xintaofei/codeg-android/releases/latest) をインストールし、デスクトップアプリの **Web サービス**か自分の `codeg-server` を指定するだけ：アドレスとトークンを入れれば完了です。接続手順は [モバイルアプリ](https://docs.codeg.app/getting-started/installation#mobile-apps)。

Compose、ビルド済みバイナリ、ソースからのビルド、その場での更新は [デプロイ](https://docs.codeg.app/getting-started/deployment) に、環境変数は [設定](https://docs.codeg.app/getting-started/configuration) にあります。Codeg 自体のビルドは [開発](https://docs.codeg.app/reference/development) と [アーキテクチャ](https://docs.codeg.app/reference/architecture) を参照。

## 🔒 プライバシーとセキュリティ

- 解析・保存・プロジェクト操作はデフォルトでローカル優先 — ネットワークアクセスはユーザーが起点となった操作でのみ発生します
- Web モードとサーバーモードはトークンベースの認証で保護されます
- 企業環境向けにシステムプロキシに対応

詳細は [プライバシーとセキュリティ](https://docs.codeg.app/reference/privacy) を参照してください。

## 👥 コミュニティ

- QRコードをスキャンして、ディスカッション、フィードバック、アップデートのための WeChat グループに参加してください

<img src="../images/weixin-light.jpg#gh-light-mode-only" alt="WeChat" width="240" />
<img src="../images/weixin-dark.jpg#gh-dark-mode-only" alt="WeChat" width="240" />

- [LinuxDO](https://linux.do) コミュニティのサポートに感謝します

## 🙏 謝辞

- [Agent Client Protocol](https://agentclientprotocol.com) — Codeg が対応するすべてのエージェントへ接続できる土台
- [Superpowers](https://github.com/obra/superpowers) — Codeg のエキスパートスキルモジュールを支えるプロジェクト
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — Codeg の Office ドキュメントワークフローを支えるプロジェクト
- [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) — Codeg の科学研究スキルを支えるプロジェクト（MIT ライセンスのサブセット）

## 📜 ライセンス

Apache-2.0。[LICENSE](../../LICENSE) を参照してください。
