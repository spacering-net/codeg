# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![Docs](https://img.shields.io/badge/docs-docs.codeg.app-3451b2)](https://docs.codeg.app)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <strong>한국어</strong> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg(Code Generation)는 멀티 에이전트 코딩 워크스페이스입니다. 모든 AI 코딩 에이전트를 한곳에서 실행하고, 서로 협업하게 만듭니다.

지원되는 모든 에이전트 CLI의 세션을 검색 가능한 하나의 워크스페이스로 모으고, 하나의 작업 안에서 메인 에이전트가 다른 종류의 서브 에이전트에게 위임할 수 있습니다. 지켜보고 앉아 있기 아까운 일은 할 일 보드에 적어 두세요. 각 작업이 자기 브랜치에서 무인으로 돌아가고, 반영되기 전에 당신의 검토를 기다립니다. Codeg는 데스크톱 앱·독립 서버·Docker 컨테이너 어느 형태로든 실행되고, 네이티브 iOS·Android 클라이언트가 있어 자리를 비운 사이에도 작업을 이어갈 수 있습니다. 열다섯 개의 에이전트가 기본 내장되며, ACP를 지원하는 다른 에이전트를 직접 등록할 수도 있습니다.

![워크스페이스](../images/workspace-light.png#gh-light-mode-only)
![워크스페이스](../images/workspace-dark.png#gh-dark-mode-only)

## 📖 문서

**전체 문서는 [docs.codeg.app](https://docs.codeg.app)** — [시작하기](https://docs.codeg.app/getting-started/) · [가이드](https://docs.codeg.app/guide/) · [레퍼런스](https://docs.codeg.app/reference/)

## 💖 스폰서

<table>
  <tr>
    <td align="center" width="220">
      <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg" target="_blank"><img src="../images/compshare.png" alt="Compshare" width="160" /></a><br/>
      <strong><a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">Compshare(UCloud)</a></strong>
    </td>
    <td>본 프로젝트를 후원해 주신 Compshare에 감사드립니다! Compshare는 UCloud 산하의 AI 클라우드 플랫폼으로, 월정액·종량제 방식의 가성비 높은 국내 모델 agent Plan 요금제를 월 49위안부터 제공합니다. 또한 안정적인 공식 프록시 방식의 해외 모델 접근도 지원합니다. Claude Code, Codex 및 API 연동을 지원하며, 기업 환경의 높은 동시성, 7×24 기술 지원, 셀프 인보이스 발급도 지원합니다. <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">이 링크</a>를 통해 가입하시면 무료 5위안 플랫폼 체험 크레딧을 받으실 수 있습니다!</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://hezu.ink/sign-up?aff=0wVz" target="_blank"><img src="../images/hezu-ink.jpg" alt="合租巴士" width="200" /></a><br/>
      <strong><a href="https://hezu.ink/sign-up?aff=0wVz">合租巴士</a></strong>
    </td>
    <td>본 프로젝트를 후원해 주신 合租巴士에 감사드립니다! 合租巴士는 Codex, Claude Code 등 주요 모델에 대한 높은 안정성의 중계 기능을 제공하는 신뢰할 수 있고 효율적인 AI 중계 서비스 플랫폼입니다. 충전 비율이 투명하며(1:1), Codex 요율 보조는 최저 0.08까지 제공됩니다. <a href="https://hezu.ink/sign-up?aff=0wVz">공식 웹사이트에서 그룹에 참여하면 $5 체험 크레딧을 받을 수 있습니다</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://console.lqapi.xyz/sign-up?aff=KPy9" target="_blank"><img src="../images/lq-router.png" alt="LQ router" width="160" /></a><br/>
      <strong><a href="https://console.lqapi.xyz/sign-up?aff=KPy9">LQ router</a></strong>
    </td>
    <td>본 프로젝트를 후원해 주신 LQ router 중계 서비스에 감사드립니다! LQ router는 전문 엔터프라이즈급 AI 중계 서비스로, 기업과 개인 개발자에게 안정적이고 효율적이며 저렴한 AI 모델 API 연동 서비스를 제공합니다. GPT, Claude, Grok, Gemini 등 주요 모델을 지원하며 GPT Pro 과금 배율은 최저 0.1배입니다. <a href="https://console.lqapi.xyz/sign-up?aff=KPy9">공식 웹사이트에서 그룹에 참여하면 1달러 체험 크레딧을 받을 수 있습니다</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://go.apimart.ai/gh-codeg" target="_blank"><img src="../images/apimart-ai.png" alt="APIMart" width="200" /></a><br/>
      <strong><a href="https://go.apimart.ai/gh-codeg">APIMart</a></strong>
    </td>
    <td>본 프로젝트를 후원해 주신 APIMart에 감사드립니다! APIMart는 AI 이미지·영상 생성에 특화된 저비용 API 플랫폼입니다. GPT-Image-2는 장당 $0.006부터라 1달러로 160장 이상을 생성할 수 있습니다. 이미지와 영상을 하나의 비동기 API로 처리합니다. 작업을 제출해 ID를 받고 폴링이나 콜백으로 결과를 가져오세요. 수만 장을 일괄 처리해도 타임아웃이 없고, 모델을 바꿔도 코드를 수정할 필요가 없습니다. 월 요금 없이 사용한 만큼만 지불합니다 — <a href="https://go.apimart.ai/gh-codeg">여기에서 가입</a>하면 바로 시작할 수 있습니다.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg" target="_blank"><img src="../images/astraflow.png" alt="UCloud ·星图AstraFlow" width="120" /></a><br/>
      <strong><a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a></strong>
    </td>
    <td>
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a><br/>
      UCloud의 星图AstraFlow 대규모 모델 플랫폼은 200개 이상의 모델을 클릭 한 번으로 호출할 수 있습니다. Kimi K3, DeepSeek V4/V3, Qwen 3, GLM5.2, happyhorse 등 세계 최고 수준의 오픈소스 대규모 모델을 기본 제공하므로 직접 학습할 필요 없이 바로 사용할 수 있습니다.<br/>
      위 링크에서 <strong>이메일</strong>로 가입하고 실명 인증을 마치면 <a href="https://f.howxm.com/xs/u/HVFW5X8EIYV1">50위안 상당의 컴퓨팅 크레딧을 받을 수 있습니다</a>.
    </td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG" target="_blank"><img src="../images/fluxion-ai.png" alt="Fluxion AI" width="160" /></a><br/>
      <strong><a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">Fluxion AI</a></strong>
    </td>
    <td>본 프로젝트를 후원해 주신 Fluxion AI에 감사드립니다! Fluxion AI는 하나의 통합 API를 통해 GPT, Claude, Gemini를 비롯한 주요 AI 모델에 빠르고 안정적이며 비용 효율적으로 접근할 수 있게 해 줍니다. 신규 사용자는 <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">전용 링크</a>를 통해 $3의 API 크레딧을 받을 수 있습니다.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA" target="_blank"><img src="../images/beeapi.jpg" alt="BeeAPI" width="200" /></a><br/>
      <strong><a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a></strong>
    </td>
    <td>본 프로젝트를 후원해 주신 <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a>에 감사드립니다! BeeAPI는 전문적인 멀티 모델 AI API 중계·통합 플랫폼으로, 여러 공급업체와 다양한 주요 AI 모델을 한데 모았습니다. 업체 간 가격 비교, 그룹별 스마트 라우팅, 통합 API 연동 및 과금을 지원하여 더 유연하고 안정적이며 저렴하게 AI 서비스를 호출할 수 있습니다.</td>
  </tr>
</table>

> Codeg의 스폰서가 되고 싶으신가요? [이메일로 문의해 주세요.](mailto:itpkcn@gmail.com)

## 🤖 지원 에이전트

Claude Code · Codex · Gemini · OpenClaw · OpenCode · Cline · Hermes · CodeBuddy · Kimi Code · Pi · Grok · Cursor · DeepSeek Harness · Qoder · Google Antigravity

이 중 대부분은 Codeg가 대신 설치하고, 버전을 고정하고, 업데이트합니다. 전체 목록과 각 에이전트의 실행 환경 요구 사항, 세션이 디스크에 저장되는 위치는 [지원 에이전트](https://docs.codeg.app/guide/supported-agents)를 참고하세요.

목록에 없나요? 직접 추가하면 됩니다. 공개된 ACP 레지스트리에서 하나를 고르거나 distribution JSON을 붙여넣으면, Codeg가 설치하고 실행 가능한지 미리 확인한 뒤 내장 에이전트와 똑같이 취급합니다 — 선택기에 나타나고, `@` 위임과 스킬을 받아들이며, 그 에이전트가 자체 기록을 남기지 않아도 대화는 저장되고 검색됩니다. → [커스텀 에이전트](https://docs.codeg.app/guide/custom-agents)

## 🤝 멀티 에이전트 협업

멀티 에이전트 협업이 키 하나로 끝납니다. `@`를 입력하고, 에이전트를 고르고, 보내기만 하면 됩니다. 나머지 스케줄링은 Codeg가 맡습니다 — 언급된 에이전트를 각각 독립 세션으로 실행하고, 작업을 넘기고, 그 결과를 지금 보고 있는 스레드로 다시 흘려보냅니다. 둘을 언급하면 나란히 진행됩니다. Claude Code가 초안을 쓰는 동안 Codex가 검토하는 식으로요. 컨텍스트 전환도, 터미널 사이를 오가는 복사·붙여넣기도 없습니다.

에이전트가 자체 서브 에이전트를 띄우는 경우 — Claude Code, Codex, Grok, OpenCode 모두 그렇습니다 — 자식마다 카드가 생기고, 끝난 뒤 한꺼번에 나타나는 대신 일하는 동안 내용이 채워집니다. 열어 보면 그 자식의 세션을 그대로 읽을 수 있습니다.

![하나의 Codeg 대화에서 서브 에이전트에게 작업을 위임하는 모습](../images/collaboration-light.gif#gh-light-mode-only)
![하나의 Codeg 대화에서 서브 에이전트에게 작업을 위임하는 모습](../images/collaboration-dark.gif#gh-dark-mode-only)

## ✅ 할 일

모든 일을 곁에서 지켜볼 필요는 없습니다. 적어 두기만 하면 — 제목, 설명, 어떤 에이전트로 돌릴지 — Codeg가 그 일에 **코드 사본 하나**를 통째로 내줍니다. 프로젝트 옆에 만들어지는 git 워크트리이고, 자기 브랜치 위에서 돕니다. 여러 개가 동시에 돌아도 서로 건드리지 않고, 지금 작업 중인 트리도 건드리지 않습니다. 오늘 밤으로 예약해 두거나, 폴더가 정해 둔 동시 실행 한도만큼 알아서 큐를 처리하게 둘 수도 있습니다.

끝난 작업이 스스로 머지하지는 않습니다. 검토 칸으로 옮겨 가 기다립니다. diff를 읽고, 한 번 더 하라고 돌려보내고, 아니면 받아들이면 — 반영은 에이전트가 합니다. 먼저 기준 브랜치를 자기 워크트리로 가져와 거기서 충돌을 모두 풀고 나서요. 그다음 Codeg는 에이전트의 말이 아니라 git을 직접 확인합니다. 확인되지 않은 머지는 성공이라고 알리는 대신 검토로 되돌아갑니다.

![할 일 보드에서 작업이 '할 일'과 '진행 중'을 거쳐 '완료'로 옮겨 가는 모습](../images/task-light.png#gh-light-mode-only)
![할 일 보드에서 작업이 '할 일'과 '진행 중'을 거쳐 '완료'로 옮겨 가는 모습](../images/task-dark.png#gh-dark-mode-only)

## 🪟 화면 분할

탭 한 줄로는 부족할 때가 있습니다. 대화 탭을 오른쪽 클릭하면 뷰를 **오른쪽**이나 **아래쪽**으로, 원하는 만큼 몇 번이든 분할할 수 있습니다. 좌우 두 칸, 위아래 세 칸, 아니면 격자 전체로도요. 각 그룹은 그 자체로 하나의 워크스페이스입니다 — 자기 탭, 자기 헤더, 자기 새 대화 버튼을 가집니다. 그래서 한 칸에서는 Claude Code가 리팩터링하고, 옆 칸에서는 Codex가 diff를 검토할 수 있습니다.

탭을 다른 그룹으로 끌어다 놓아도 그 세션은 이동 중에도 계속 스트리밍됩니다. 두 그룹 사이의 구분선을 끌면 공간을 나누는 비율이 바뀝니다. 레이아웃은 워크스페이스별로, 초안까지 함께 기억됩니다. Codeg를 다시 열면 분할이 그대로 돌아오고, 보내지 않은 글도 입력창에 남아 있습니다.

![대화 영역을 탭 그룹 격자로 분할하기](../images/split-light.gif#gh-light-mode-only)
![대화 영역을 탭 그룹 격자로 분할하기](../images/split-dark.gif#gh-dark-mode-only)

## 📄 Office 문서

덱이든 보고서든 워크북이든, 요청하면 에이전트가 진짜 `.pptx` / `.docx` / `.xlsx` 파일을 만듭니다 — 오른쪽 패널이 그것을 실시간으로 렌더링하는 동안에요. 수정은 알아서 미리보기에 반영됩니다. 슬라이드가 채워지고, 표가 자리를 잡고, 숫자가 셀에 들어갑니다. 4번 슬라이드가 마음에 들지 않나요? 다음 메시지로 말하면 됩니다 — 에이전트가 같은 파일을 그 자리에서 고치고, 미리보기가 따라옵니다. 내보내기도, 외부 Office 앱도, Codeg를 벗어날 일도 없습니다.

![라이브 미리보기를 옆에 두고 Office 문서를 편집하는 에이전트](../images/office-light.png#gh-light-mode-only)
![라이브 미리보기를 옆에 두고 Office 문서를 편집하는 에이전트](../images/office-dark.png#gh-dark-mode-only)

## 💻 워크스페이스

워크스페이스는 하나, 에이전트는 전부. 무엇이 일하고 있든 — Claude Code든 Codex든 Cursor든 — 같은 에디터, 같은 실시간 diff, 같은 Git 클라이언트 안에서 움직입니다. 그리고 만들어지는 것은 저장소 안의 진짜 파일이며, 보는 앞에서 바뀝니다. 다른 디렉터리를 끌어와 붙일 수도 있습니다 — 공용 라이브러리, 옆에 있는 서비스, 문서 저장소 — 파일 트리도 검색도 에이전트 자신도 그것들을 하나의 워크스페이스로 다룹니다.

**세션.** 이미 가진 기록을 그대로 가져오세요. 설치된 모든 에이전트의 지난 세션을 클릭 한 번으로 불러오고, 멈춘 지점부터 이어갑니다. 들어온 뒤로는 서로 단절된 섬이 아닙니다 — 예전 세션을 `@`로 언급하면 지금 대화 중인 에이전트가 그것을 읽습니다. 다른 에이전트가 남긴 것이어도 마찬가지라, 오늘의 Codex가 지난주 Claude Code가 끝낸 지점에서 이어갑니다. 대화가 아무리 길어져도 열 때는 최근 라운드부터 보여주고, 나머지는 위로 거슬러 올라가는 대로 이어서 불러옵니다.

**파일.** 에이전트의 수정은 반영되는 즉시 대화 옆에 diff로 나타납니다. 어떤 파일이든 구문 강조가 되는 진짜 에디터에서 열고, `⌘L`로 파일 전체나 선택한 부분만 에이전트에게 바로 넘기고, Markdown·HTML·이미지·Office 문서를 같은 패널에서 미리 봅니다.

**Git.** 상태 표시가 아니라 완전한 클라이언트입니다. 변경 사항 탭에서 바로 커밋하고 — 메시지를 쓰고 Enter — 그 옆에 pull, fetch, push, stash가 있으며, 히스토리는 어떤 커밋이 푸시됐는지 보여줍니다. 브랜치·머지·리베이스·리셋, 다른 브랜치와의 비교는 물론, 옮겨 가지 않고도 어떤 브랜치든 업데이트하거나 푸시할 수 있습니다. 충돌은 3분할 머지 에디터로 열려 헝크 단위로 받아들이거나 직접 고쳐 씁니다. 그리고 워크트리는 병렬 작업을 한 번의 동작으로 만듭니다 — 새 브랜치, 전용 디렉터리, 그리고 그 안에 뿌리내린 새 대화. 여러 에이전트가 서로의 파일을 건드리지 않고 서로 다른 기능을 동시에 만듭니다.

**잘못됐을 때.** 실패한 턴은 그냥 문제가 생겼다고만 하지 않습니다. Claude Code와 Codex에서는 종류까지 말해 줍니다 — 연결 문제, 접근 문제, 한도 도달, 요청 거부, 서비스 문제 — 그리고 입력창 아래에 실제로 도움이 될 것만 담은 띠를 붙입니다. 다시 시도, 로그인, 또는 새 세션. 에이전트가 스스로 재시도하는 동안에는 호박색으로 표시되고, 턴이 무사히 끝나면 '복구됨' 한 줄로 정리됩니다. 입력창 아래 연결 상태 아이콘도 버튼입니다. 누르면 그 세션의 실제 상태가 나오고, 새로 시작하는 대신 이어받는 '다시 연결'도 거기 있습니다.

## 📱 iPhone, iPad & Android

책상을 떠나도 작업은 멈추지 않습니다. 네이티브 iOS·Android 클라이언트는 이미 돌아가고 있는 당신의 Codeg —— 데스크톱 앱의 **웹 서비스**, 또는 직접 운영하는 `codeg-server` —— 에 연결됩니다. 거기서 세션을 시작하고, 응답과 도구 호출이 실시간으로 흘러드는 것을 지켜보고, 권한 요청에 답하고, 프로젝트와 브랜치를 둘러볼 수 있습니다. 휴대폰으로 옮겨지는 것은 없습니다. 파일과 에이전트 CLI, 대화는 Codeg가 도는 컴퓨터에 그대로 남고, 액세스 토큰은 iOS 키체인이나 Android 키스토어가 보관합니다. 두 클라이언트 모두 오픈 소스입니다([iOS](https://github.com/xintaofei/codeg-ios), [Android](https://github.com/xintaofei/codeg-android)). 연결은 세 단계면 끝나며, 자세한 내용은 [모바일 앱](https://docs.codeg.app/getting-started/installation#mobile-apps)에 있습니다.

| iPhone & iPad | Android |
| :---: | :---: |
| <img src="../images/mobile-ios.jpg" alt="Codeg iOS 클라이언트에서 세션을 시작하는 화면" width="248" /> | <img src="../images/mobile-android.jpg" alt="Codeg Android 클라이언트로 흘러드는 에이전트 응답" width="248" /> |

## ✨ 하이라이트

- **[대화 통합](https://docs.codeg.app/guide/aggregation)** — 지원되는 모든 에이전트의 세션을 검색 가능한 하나의 워크스페이스로 가져오고, 멈춘 지점부터 이어서 진행합니다
- **[멀티 에이전트 협업](https://docs.codeg.app/guide/multi-agent)** — `@`로 에이전트를 언급하면 곧 위임입니다. 서로 다른 종류의 서브 에이전트가 각자 독립 세션으로, 하나의 작업 안에서 병렬로 실행됩니다
- **[할 일](https://docs.codeg.app/guide/tasks)** — 해야 할 일을 적어 두면 에이전트가 큐를 하나씩 비워 갑니다. 각 작업은 자기 워크트리에서 돌고, 당신이 검토한 뒤에야 브랜치에 반영됩니다
- **[커스텀 에이전트](https://docs.codeg.app/guide/custom-agents)** — 공개 레지스트리나 distribution JSON으로 ACP 호환 에이전트를 등록하세요. Codeg가 설치와 기록을 맡고, 내장 에이전트와 똑같이 다룹니다
- **[워크스페이스](https://docs.codeg.app/guide/workspace)** — 에이전트 옆에 개발의 전 과정이 있습니다: 파일 트리, 에디터와 diff, Git 변경 사항, 커밋, 내장 터미널, 그리고 [하나의 워크스페이스로 묶은 여러 폴더](https://docs.codeg.app/guide/workspace#work-across-several-folders)
- **[화면 분할](https://docs.codeg.app/guide/workspace#split-the-conversation-view-into-groups)** — 대화 영역을 원하는 만큼 탭 그룹으로 나누고, 그룹 사이로 탭과 구분선을 끌어 조정하며, 재시작 후에도 초안까지 포함해 레이아웃이 돌아옵니다
- **[Git과 Worktree](https://docs.codeg.app/guide/git)** — 변경 사항 검토와 커밋, Git 원격 계정 관리, 내장 `git worktree` 흐름을 이용한 병렬 작업
- **[토큰 사용량](https://docs.codeg.app/guide/token-usage)** — 상태 표시줄 카운터 뒤의 전체 보고서: 추이와 캐시 적중률, 활동 히트맵, 폴더·에이전트·모델·세션별 분석
- **[채팅 채널](https://docs.codeg.app/guide/chat-channels)** — Telegram, Lark(Feishu), WeChat에서 에이전트를 조작합니다: 작업 생성, 권한 승인, 실시간 진행 상황 수신
- **[자동화](https://docs.codeg.app/guide/automations)** — 설정을 마친 입력창을 재사용 가능한 자동화로 저장해 cron 일정이나 필요할 때 헤드리스로 실행합니다. 세션을 시작할 수도, 나중에 검토할 할 일을 쌓아 둘 수도 있습니다
- **[Office 문서](https://docs.codeg.app/guide/office)** — 내장 `officecli`로 `.docx` / `.xlsx` / `.pptx`를 만들고 분석·교정·편집하며, 탭 안에서 실시간 미리보기를 제공합니다
- **[과학 연구](https://docs.codeg.app/guide/research)** — 내장 연구 스킬(가설 생성, 실험 설계, 통계, 시각화, 비판적 평가, 문헌 검색)을 어떤 에이전트에서든 호출할 수 있습니다
- **[프로젝트 부트](https://docs.codeg.app/guide/project-boot)** — 실시간 미리보기와 함께 새 프로젝트를 시각적으로 구성하고, 곧바로 워크스페이스에서 엽니다
- **[MCP](https://docs.codeg.app/guide/mcp) & [스킬](https://docs.codeg.app/guide/skills)** — 로컬 서버 스캔과 레지스트리 검색/설치, 스킬은 전역 또는 프로젝트 범위로 관리
- **[내 취향대로](https://docs.codeg.app/reference/settings/appearance)** — 열두 가지 테마를 색상 토큰 단위로 바꾸고, 모서리 둥글기를 앱 전체에 적용하고, 테마를 shadcn JSON으로 가져오고 내보내거나, 직접 CSS를 씁니다
- **[데스크톱·서버·Docker](https://docs.codeg.app/getting-started/deployment)** — 네이티브 데스크톱 앱, 브라우저로 접속하는 독립 실행형 `codeg-server`, 또는 `docker compose up`
- **[iPhone, iPad & Android](https://docs.codeg.app/getting-started/installation#mobile-apps)** — 데스크톱이나 서버에 연결되는 네이티브 모바일 클라이언트: 어디서나 세션을 시작하고, 응답을 스트리밍으로 받고, 권한을 승인하고, 프로젝트를 살펴봅니다

## 📦 설치 및 실행

**데스크톱** — [Releases](https://github.com/xintaofei/codeg/releases)에서 macOS, Windows, Linux용 설치 프로그램을 내려받은 뒤 [설치](https://docs.codeg.app/getting-started/installation) 안내를 따르세요.

**서버** — Codeg를 헤드리스로 실행하고 어떤 브라우저에서든 접속합니다. Linux 또는 macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
CODEG_STATIC_DIR=/usr/local/share/codeg/web codeg-server
```

Windows(PowerShell):

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
$env:CODEG_STATIC_DIR="$env:LOCALAPPDATA\codeg\web"; codeg-server
```

**Docker** — 같은 서버를, 컨테이너 하나로:

```bash
docker run -d -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

**모바일** — [iOS 앱](https://apps.apple.com/app/codeg-client/id6785199071) 또는 [Android APK](https://github.com/xintaofei/codeg-android/releases/latest)를 설치한 뒤 데스크톱 앱의 **웹 서비스**나 직접 운영하는 `codeg-server`를 가리키게 하세요: 주소와 토큰만 넣으면 끝입니다. 연결 절차는 [모바일 앱](https://docs.codeg.app/getting-started/installation#mobile-apps) 참고.

Compose, 사전 빌드 바이너리, 소스 빌드, 무중단 업데이트는 [배포](https://docs.codeg.app/getting-started/deployment)에서, 환경 변수는 [설정](https://docs.codeg.app/getting-started/configuration)에서 다룹니다. Codeg 자체를 빌드하려면 [개발](https://docs.codeg.app/reference/development)과 [아키텍처](https://docs.codeg.app/reference/architecture)를 보세요.

## 🔒 개인정보 보호 및 보안

- 파싱·저장·프로젝트 작업은 기본적으로 로컬 우선 — 네트워크 접근은 사용자가 시작한 동작에서만 발생합니다
- 웹 모드와 서버 모드는 토큰 기반 인증으로 보호됩니다
- 기업 환경을 위한 시스템 프록시 지원

자세한 내용은 [개인정보 보호 및 보안](https://docs.codeg.app/reference/privacy)을 참고하세요.

## 👥 커뮤니티

- 아래 QR 코드를 스캔하여 토론, 피드백, 업데이트를 위한 WeChat 그룹에 참여하세요

<img src="../images/weixin-light.jpg#gh-light-mode-only" alt="WeChat" width="240" />
<img src="../images/weixin-dark.jpg#gh-dark-mode-only" alt="WeChat" width="240" />

- [LinuxDO](https://linux.do) 커뮤니티의 지원에 감사드립니다

## 🙏 감사의 말

- [Agent Client Protocol](https://agentclientprotocol.com) — Codeg가 지원하는 모든 에이전트에 연결할 수 있게 해주는 토대
- [Superpowers](https://github.com/obra/superpowers) — Codeg의 전문가 스킬 모듈을 지원하는 프로젝트
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — Codeg의 Office 문서 워크플로우를 지원하는 프로젝트
- [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) — Codeg의 과학 연구 스킬을 지원하는 프로젝트 (MIT 라이선스 서브셋)

## 📜 라이선스

Apache-2.0. [LICENSE](../../LICENSE)를 참고하세요.
