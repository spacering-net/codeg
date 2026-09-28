# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![Docs](https://img.shields.io/badge/docs-docs.codeg.app-3451b2)](https://docs.codeg.app)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <strong>Deutsch</strong> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) ist ein Multi-Agent-Coding-Workspace: Führe jeden KI-Coding-Agenten an einem Ort aus — und lass sie zusammenarbeiten.

Codeg bündelt die Sitzungen aller unterstützten Agenten-CLIs in einem durchsuchbaren Workspace und lässt einen Haupt-Agenten innerhalb einer Aufgabe an Sub-Agenten anderer Typen delegieren. Arbeit, bei der du nicht danebensitzen willst, kommt stattdessen aufs To-do-Board — jede Aufgabe in ihrem eigenen Branch, unbeaufsichtigt laufend und wartend auf deine Freigabe, bevor sie landet. Codeg läuft als Desktop-App, eigenständiger Server oder Docker-Container, dazu native iOS- und Android-Clients für die Zeit fernab vom Schreibtisch; fünfzehn Agenten sind eingebaut, und jeden weiteren ACP-kompatiblen Agenten kannst du selbst registrieren.

![Workspace](../images/workspace-light.png#gh-light-mode-only)
![Workspace](../images/workspace-dark.png#gh-dark-mode-only)

## 📖 Dokumentation

**Die vollständige Dokumentation liegt unter [docs.codeg.app](https://docs.codeg.app)** — [Erste Schritte](https://docs.codeg.app/getting-started/) · [Guide](https://docs.codeg.app/guide/) · [Referenz](https://docs.codeg.app/reference/)

## 💖 Sponsoren

<table>
  <tr>
    <td align="center" width="220">
      <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg" target="_blank"><img src="../images/compshare.png" alt="Compshare" width="160" /></a><br/>
      <strong><a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">Compshare (UCloud)</a></strong>
    </td>
    <td>Vielen Dank an Compshare für die Unterstützung dieses Projekts! Compshare ist die KI-Cloud-Plattform von UCloud und bietet preiswerte monatliche und nutzungsbasierte Plan-Tarife für inländische Modell-Agents ab 49 ¥/Monat. Zusätzlich bietet sie stabilen, offiziell weitergeleiteten Zugriff auf Modelle aus Übersee. Unterstützt Claude Code, Codex und API-Aufrufe. Enterprise-tauglich: hohe Parallelität, 24/7-Support, Self-Service-Rechnungsstellung. Wer sich über <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">diesen Link</a> registriert, erhält 5 ¥ Plattformguthaben gratis!</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://hezu.ink/sign-up?aff=0wVz" target="_blank"><img src="../images/hezu-ink.jpg" alt="合租巴士" width="200" /></a><br/>
      <strong><a href="https://hezu.ink/sign-up?aff=0wVz">合租巴士</a></strong>
    </td>
    <td>Vielen Dank an 合租巴士 für die Unterstützung dieses Projekts! 合租巴士 ist eine zuverlässige und effiziente KI-Relay-Plattform, die hochstabiles Relay für gängige Modelle wie Codex und Claude Code bietet. Das Aufladeverhältnis ist transparent (1:1), mit Codex-Ratenzuschüssen ab nur 0,08. <a href="https://hezu.ink/sign-up?aff=0wVz">Treten Sie der Gruppe über die offizielle Website bei und erhalten Sie 5 USD Testguthaben</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://console.lqapi.xyz/sign-up?aff=KPy9" target="_blank"><img src="../images/lq-router.png" alt="LQ router" width="160" /></a><br/>
      <strong><a href="https://console.lqapi.xyz/sign-up?aff=KPy9">LQ router</a></strong>
    </td>
    <td>Vielen Dank an den Relay-Dienst LQ router für die Unterstützung dieses Projekts! LQ router ist ein professioneller KI-Relay-Dienst auf Enterprise-Niveau, der Unternehmen und einzelnen Entwicklern einen stabilen, effizienten und kostengünstigen Zugang zu KI-Modell-APIs bietet. Die Plattform unterstützt führende Modelle wie GPT, Claude, Grok und Gemini, mit Abrechnungsfaktoren für GPT Pro von nur 0,1×. <a href="https://console.lqapi.xyz/sign-up?aff=KPy9">Über die offizielle Website der Gruppe beitreten und 1 USD Testguthaben erhalten</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://go.apimart.ai/gh-codeg" target="_blank"><img src="../images/apimart-ai.png" alt="APIMart" width="200" /></a><br/>
      <strong><a href="https://go.apimart.ai/gh-codeg">APIMart</a></strong>
    </td>
    <td>Vielen Dank an APIMart für die Unterstützung dieses Projekts! APIMart ist eine günstige API-Plattform für KI-Bild- und Videogenerierung – GPT-Image-2 ab 0,006 USD pro Bild, über 160 Bilder pro Dollar. Eine einzige asynchrone API deckt Bild und Video ab: Aufgabe einreichen, ID erhalten, Ergebnisse per Polling oder Callback abholen. Zehntausende Bilder im Batch verarbeiten, ohne dass es zu Timeouts kommt, und Modelle wechseln, ohne den Code zu ändern. Nutzungsbasierte Abrechnung ohne Monatsgebühr – <a href="https://go.apimart.ai/gh-codeg">hier registrieren</a> und direkt loslegen.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg" target="_blank"><img src="../images/astraflow.png" alt="UCloud ·星图AstraFlow" width="120" /></a><br/>
      <strong><a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a></strong>
    </td>
    <td>
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a><br/>
      AstraFlow, die Plattform für große Modelle von UCloud, bietet Zugriff auf über 200 Modelle per Klick: Führende Open-Source-Modelle wie Kimi K3, DeepSeek V4/V3, Qwen 3, GLM5.2 und happyhorse sind bereits integriert – kein eigenes Training nötig, sofort einsatzbereit.<br/>
      Über den Link oben mit der <strong>E-Mail-Adresse</strong> registrieren, die Identitätsprüfung abschließen und <a href="https://f.howxm.com/xs/u/HVFW5X8EIYV1">50 ¥ Rechenguthaben erhalten</a>.
    </td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG" target="_blank"><img src="../images/fluxion-ai.png" alt="Fluxion AI" width="160" /></a><br/>
      <strong><a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">Fluxion AI</a></strong>
    </td>
    <td>Vielen Dank an Fluxion AI für die Unterstützung dieses Projekts! Fluxion AI bietet über eine einzige einheitliche API schnellen, zuverlässigen und kosteneffizienten Zugriff auf GPT, Claude, Gemini und weitere führende KI-Modelle. Neue Nutzer erhalten über <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">unseren speziellen Link</a> 3 USD API-Guthaben.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA" target="_blank"><img src="../images/beeapi.jpg" alt="BeeAPI" width="200" /></a><br/>
      <strong><a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a></strong>
    </td>
    <td>Vielen Dank an <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a> für die Unterstützung dieses Projekts! BeeAPI ist eine professionelle Relay- und Aggregationsplattform für KI-APIs mit mehreren Modellen, die zahlreiche Anbieter und viele gängige KI-Modelle zusammenführt. Sie unterstützt anbieterübergreifende Preisvergleiche, intelligentes Routing über mehrere Gruppen sowie einheitlichen API-Zugang und einheitliche Abrechnung – für einen flexibleren, stabileren und günstigeren Zugriff auf KI-Dienste.</td>
  </tr>
</table>

> Möchten Sie Codeg-Sponsor werden? [Schreiben Sie uns gerne eine E-Mail.](mailto:itpkcn@gmail.com)

## 🤖 Unterstützte Agenten

Claude Code · Codex · Gemini · OpenClaw · OpenCode · Cline · Hermes · CodeBuddy · Kimi Code · Pi · Grok · Cursor · DeepSeek Harness · Qoder · Google Antigravity

Die meisten davon installiert, fixiert und aktualisiert Codeg für dich. Die vollständige Liste, die Laufzeit-Anforderungen jedes Agenten und den Ablageort seiner Sitzungen findest du unter [Unterstützte Agenten](https://docs.codeg.app/guide/supported-agents).

Nicht dabei? Füge ihn selbst hinzu. Wähle einen Agenten aus der öffentlichen ACP-Registry oder füge sein Distribution-JSON ein — Codeg installiert ihn, prüft vorab, ob er startet, und behandelt ihn wie einen eingebauten: Er erscheint im Picker, nimmt `@`-Delegation und Skills an, und seine Unterhaltungen werden aufgezeichnet und durchsuchbar, selbst wenn der Agent selbst keine Historie führt. → [Eigene Agenten](https://docs.codeg.app/guide/custom-agents)

## 🤝 Multi-Agent-Zusammenarbeit

Multi-Agent-Zusammenarbeit, reduziert auf einen Tastendruck: `@` tippen, Agenten auswählen, absenden. Um die Orchestrierung kümmert sich Codeg — es startet jeden erwähnten Agenten als eigene Sitzung, übergibt die Aufgabe und streamt die Arbeit zurück in den Thread, in dem du ohnehin bist. Erwähne zwei, und sie laufen nebeneinander: Claude Code schreibt, Codex prüft. Kein Kontextwechsel, kein Copy-and-paste zwischen Terminals.

Und wenn ein Agent eigene Sub-Agenten startet — Claude Code, Codex, Grok und OpenCode tun das alle — bekommt jedes Kind eine eigene Karte, die sich während der Arbeit füllt, statt erst am Ende auf einen Schlag zu erscheinen. Öffne eine, und du liest die Sitzung des Kindes selbst.

![Eine Aufgabe wird aus einer einzigen Codeg-Unterhaltung an Sub-Agenten delegiert](../images/collaboration-light.gif#gh-light-mode-only)
![Eine Aufgabe wird aus einer einzigen Codeg-Unterhaltung an Sub-Agenten delegiert](../images/collaboration-dark.gif#gh-dark-mode-only)

## ✅ To-dos

Nicht jede Arbeit braucht dich als Zuschauer. Schreib sie auf — ein Titel, eine Beschreibung, der Agent, der sie erledigen soll — und Codeg gibt ihr **eine eigene Kopie des Codes**: ein Git-Worktree neben deinem Projekt, auf einem eigenen Branch. Mehrere laufen gleichzeitig, ohne sich gegenseitig oder den Baum zu berühren, in dem du gerade arbeitest. Plane eine für heute Abend, oder lass einen Ordner seine Warteschlange selbst abarbeiten, bis zu dem Limit, das du festlegst.

Eine fertige Aufgabe merged sich nicht selbst. Sie wandert in die Review-Spalte und wartet: Diff lesen, für eine weitere Runde zurückschicken oder annehmen — und der Agent bringt sie ein, holt dafür erst deinen Base-Branch in sein Worktree und löst die Konflikte dort. Danach glaubt Codeg dem Agenten nicht aufs Wort, sondern prüft Git selbst: Ein Merge, den es nicht bestätigen kann, geht zurück ins Review, statt Erfolg zu melden.

![Das To-do-Board, auf dem Aufgaben von „To-do“ über „In Arbeit“ nach „Fertig“ wandern](../images/task-light.png#gh-light-mode-only)
![Das To-do-Board, auf dem Aufgaben von „To-do“ über „In Arbeit“ nach „Fertig“ wandern](../images/task-dark.png#gh-dark-mode-only)

## 🪟 Split-Ansicht

Eine Tab-Leiste reicht nicht immer. Ein Rechtsklick auf einen Unterhaltungs-Tab teilt die Ansicht **nach rechts** oder **nach unten** — beliebig oft: zwei Panes nebeneinander, drei gestapelt, ein Raster. Jede Gruppe ist ein vollwertiger Workspace — eigene Tabs, eigener Header, eigener Button für eine neue Unterhaltung — so refaktoriert Claude Code im einen Pane, während Codex im nächsten einen Diff prüft.

Zieh einen Tab von einer Gruppe in die andere: Seine Sitzung streamt während des Umzugs weiter. Zieh den Teiler zwischen zwei Gruppen, um den Platz anders aufzuteilen. Das Layout wird pro Workspace gemerkt, Entwürfe inklusive — öffne Codeg wieder, und die Aufteilung ist zurück, mit dem nie abgesendeten Text noch im Eingabefeld.

![Der Unterhaltungsbereich wird in ein Raster aus Tab-Gruppen geteilt](../images/split-light.gif#gh-light-mode-only)
![Der Unterhaltungsbereich wird in ein Raster aus Tab-Gruppen geteilt](../images/split-dark.gif#gh-dark-mode-only)

## 📄 Office-Dokumente

Bitte um ein Deck, einen Bericht oder eine Arbeitsmappe, und der Agent baut eine echte `.pptx` / `.docx` / `.xlsx` — während der rechte Bereich sie live rendert. Jede Änderung landet von selbst in der Vorschau: Folien füllen sich, Tabellen nehmen Gestalt an, Zahlen landen in den Zellen. Folie 4 gefällt nicht? Sag es in der nächsten Nachricht — der Agent bearbeitet dieselbe Datei an Ort und Stelle, die Vorschau zieht nach. Kein Export, keine externe Office-App, kein Verlassen von Codeg.

![Ein Agent bearbeitet ein Office-Dokument neben dessen Live-Vorschau](../images/office-light.png#gh-light-mode-only)
![Ein Agent bearbeitet ein Office-Dokument neben dessen Live-Vorschau](../images/office-dark.png#gh-dark-mode-only)

## 💻 Workspace

Ein Workspace, alle Agenten. Egal welcher gerade arbeitet — Claude Code, Codex, Cursor —, er tut es im selben Editor, mit denselben Live-Diffs und demselben Git-Client. Und was dabei entsteht, sind echte Dateien in deinem Repository, die sich vor deinen Augen verändern. Binde weitere Verzeichnisse ein — eine gemeinsame Bibliothek, einen Nachbardienst, das Docs-Repository — und Dateibaum, Suche und der Agent selbst behandeln sie als einen Workspace.

**Sitzungen.** Hol dir die Historie, die du schon hast: vergangene Sitzungen aller installierten Agenten, mit einem Klick importiert und dort fortsetzbar, wo du aufgehört hast. Einmal drin, bleiben sie keine getrennten Silos — erwähne eine alte Sitzung mit `@`, und der Agent, mit dem du gerade sprichst, kann sie lesen, auch wenn ein anderer Agent sie geschrieben hat. So macht der heutige Codex-Lauf da weiter, wo die Claude-Code-Sitzung von letzter Woche aufgehört hat. Wie lang ein Verlauf auch wird: Er öffnet sich mit den jüngsten Runden und lädt den Rest nach, während du nach oben scrollst.

**Dateien.** Die Änderungen des Agenten erscheinen als Diffs neben der Unterhaltung, sobald sie landen. Öffne jede Datei in einem echten Editor mit Syntaxhervorhebung, schick eine Datei — oder nur eine Auswahl — mit `⌘L` direkt an den Agenten, und zeig dir Markdown, HTML, Bilder und Office-Dokumente in derselben Ansicht in der Vorschau an.

**Git.** Ein vollwertiger Client, keine Statusanzeige: committe direkt aus dem Tab „Änderungen“ — Nachricht tippen, Enter — mit Pull, Fetch, Push und Stash daneben und einer Historie, die zeigt, welche Commits gepusht sind. Branches anlegen, mergen, rebasen, zurücksetzen oder gegen einen anderen Branch diffen — und jeden Branch aktualisieren oder pushen, ohne zu ihm zu wechseln. Konflikte öffnen einen dreispaltigen Merge-Editor, in dem du Hunk für Hunk übernimmst oder die Lösung selbst tippst. Und Worktrees machen paralleles Arbeiten zu einer einzigen Aktion — ein neuer Branch, ein eigenes Verzeichnis und eine frische Unterhaltung darin, sodass eine ganze Flotte von Agenten gleichzeitig an verschiedenen Features baut, ohne einander in die Quere zu kommen.

**Wenn etwas schiefgeht.** Ein gescheiterter Turn sagt nicht bloß, dass etwas schiefging — bei Claude Code und Codex nennt er die Art: ein Verbindungsproblem, ein Zugriffsproblem, ein erreichtes Limit, eine abgelehnte Anfrage, ein Dienstproblem — und legt unter den Composer einen Streifen mit dem, was wirklich hilft: Wiederholen, Anmelden oder eine neue Sitzung. Versuche, die der Agent von sich aus unternimmt, erscheinen bernsteinfarben und schrumpfen am Ende auf eine einzige Zeile „Wiederhergestellt“. Und die Verbindungsanzeige unter dem Composer ist ein Button: ein Klick zeigt den echten Zustand der Sitzung — samt einem Reconnect, das fortsetzt statt neu zu beginnen.

## 📱 iPhone, iPad & Android

Geh vom Schreibtisch weg, nicht von der Arbeit. Die nativen iOS- und Android-Clients verbinden sich mit dem Codeg, das du ohnehin betreibst — dem **Web Service** deiner Desktop-App oder deinem eigenen `codeg-server`. Von dort startest du Sitzungen, verfolgst Antworten und Tool-Aufrufe im Stream, beantwortest Berechtigungsanfragen und siehst dir Projekte und Branches an. Aufs Telefon wandert nichts: Dateien, Agenten-CLIs und Unterhaltungen bleiben auf der Maschine, die Codeg ausführt, und das Zugriffstoken liegt im iOS-Keychain oder im Android Keystore. Beide Clients sind Open Source ([iOS](https://github.com/xintaofei/codeg-ios), [Android](https://github.com/xintaofei/codeg-android)); das Koppeln dauert drei Schritte und steht in [Mobile Apps](https://docs.codeg.app/getting-started/installation#mobile-apps).

| iPhone & iPad | Android |
| :---: | :---: |
| <img src="../images/mobile-ios.jpg" alt="Eine Sitzung wird im Codeg-iOS-Client gestartet" width="248" /> | <img src="../images/mobile-android.jpg" alt="Eine Agenten-Antwort, die live in den Codeg-Android-Client läuft" width="248" /> |

## ✨ Highlights

- **[Sitzungs-Aggregation](https://docs.codeg.app/guide/aggregation)** — importiert Sitzungen aller unterstützten Agenten in einen einheitlichen, durchsuchbaren Workspace — und du machst dort weiter, wo du aufgehört hast
- **[Multi-Agent-Zusammenarbeit](https://docs.codeg.app/guide/multi-agent)** — per `@`-Erwähnung an jeden Agenten delegieren: Sub-Agenten unterschiedlicher Typen laufen als eigene Sitzungen, parallel, innerhalb einer Aufgabe
- **[To-dos](https://docs.codeg.app/guide/tasks)** — schreib auf, was zu tun ist, und Agenten arbeiten die Warteschlange ab, jede Aufgabe in ihrem eigenen Worktree — auf deinem Branch landet sie erst, nachdem du sie geprüft hast
- **[Eigene Agenten](https://docs.codeg.app/guide/custom-agents)** — jeden weiteren ACP-kompatiblen Agenten aus der öffentlichen Registry oder per Distribution-JSON registrieren; Codeg installiert ihn, zeichnet seine Historie auf und behandelt ihn wie einen eingebauten
- **[Der Workspace](https://docs.codeg.app/guide/workspace)** — der komplette Engineering-Loop direkt neben dem Agenten: Dateibaum, Editor und Diff, Git-Änderungen, Commit, ein eingebettetes Terminal und [mehrere Ordner, zu einem Workspace verbunden](https://docs.codeg.app/guide/workspace#work-across-several-folders)
- **[Split-Ansicht](https://docs.codeg.app/guide/workspace#split-the-conversation-view-into-groups)** — den Unterhaltungsbereich in beliebig viele Tab-Gruppen teilen, Tabs und Teiler zwischen ihnen ziehen und das Layout — samt Entwürfen — nach dem Neustart zurückbekommen
- **[Git & Worktrees](https://docs.codeg.app/guide/git)** — Änderungen prüfen und committen, Git-Remote-Konten verwalten und mit integrierten `git worktree`-Abläufen parallel arbeiten
- **[Token-Nutzung](https://docs.codeg.app/guide/token-usage)** — hinter dem Zähler in der Statusleiste steckt ein vollständiger Bericht: Verläufe und Cache-Trefferquote, eine Aktivitäts-Heatmap und Aufschlüsselungen nach Ordner, Agent, Modell und Sitzung
- **[Chat-Kanäle](https://docs.codeg.app/guide/chat-channels)** — steuere deine Agenten aus Telegram, Lark (Feishu) und WeChat: Aufgaben anlegen, Berechtigungen freigeben, Live-Updates erhalten
- **[Automatisierungen](https://docs.codeg.app/guide/automations)** — einen fertig konfigurierten Composer als wiederverwendbare Automatisierung sichern und headless per Cron-Zeitplan oder auf Zuruf ausführen — sie startet eine Sitzung oder legt ein To-do an, das du später prüfst
- **[Office-Dokumente](https://docs.codeg.app/guide/office)** — `.docx` / `.xlsx` / `.pptx` mit dem mitgelieferten `officecli` erstellen, analysieren, korrigieren und bearbeiten — mit Live-Vorschau im Tab
- **[Wissenschaftliche Recherche](https://docs.codeg.app/guide/research)** — mitgelieferte Research-Skills (Hypothesenbildung, Versuchsplanung, Statistik, Visualisierung, kritische Bewertung, Literatursuche), die jeder Agent aufrufen kann
- **[Project Boot](https://docs.codeg.app/guide/project-boot)** — neue Projekte visuell aufsetzen, mit Live-Vorschau, und direkt im Workspace öffnen
- **[MCP](https://docs.codeg.app/guide/mcp) & [Skills](https://docs.codeg.app/guide/skills)** — lokaler Server-Scan plus Suche/Installation aus der Registry, Skills global oder pro Projekt verwaltet
- **[Mach es zu deinem](https://docs.codeg.app/reference/settings/appearance)** — jedes der zwölf Themes Token für Token umfärben, den Eckenradius app-weit setzen, Themes als shadcn-JSON importieren und exportieren oder eigenes CSS schreiben
- **[Desktop, Server & Docker](https://docs.codeg.app/getting-started/deployment)** — eine native Desktop-App, ein eigenständiger `codeg-server` für den Browser oder `docker compose up`
- **[iPhone, iPad & Android](https://docs.codeg.app/getting-started/installation#mobile-apps)** — native Mobile-Clients, die sich mit deinem Desktop oder Server verbinden: Sitzungen starten, Antworten streamen, Berechtigungen freigeben und Projekte von überall durchsehen

## 📦 Installation & Betrieb

**Desktop** — Lade den Installer für macOS, Windows oder Linux aus den [Releases](https://github.com/xintaofei/codeg/releases) und folge der [Installation](https://docs.codeg.app/getting-started/installation).

**Server** — Codeg headless betreiben und aus jedem Browser erreichen. Unter Linux oder macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
CODEG_STATIC_DIR=/usr/local/share/codeg/web codeg-server
```

Unter Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
$env:CODEG_STATIC_DIR="$env:LOCALAPPDATA\codeg\web"; codeg-server
```

**Docker** — derselbe Server, in einem Container:

```bash
docker run -d -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

**Mobil** — installiere die [iOS-App](https://apps.apple.com/app/codeg-client/id6785199071) oder das [Android-APK](https://github.com/xintaofei/codeg-android/releases/latest) und richte sie auf den **Web Service** deiner Desktop-App oder deinen eigenen `codeg-server`: URL, Token, fertig. Die Kopplungsschritte stehen in [Mobile Apps](https://docs.codeg.app/getting-started/installation#mobile-apps).

Compose, vorgebaute Binaries, Builds aus dem Quellcode und In-place-Updates stehen unter [Deployment](https://docs.codeg.app/getting-started/deployment); Umgebungsvariablen unter [Konfiguration](https://docs.codeg.app/getting-started/configuration). Codeg selbst bauen: [Entwicklung](https://docs.codeg.app/reference/development) und [Architektur](https://docs.codeg.app/reference/architecture).

## 🔒 Datenschutz und Sicherheit

- Standardmäßig local-first bei Parsing, Speicherung und Projektoperationen — Netzwerkzugriffe passieren nur bei von dir ausgelösten Aktionen
- Web- und Server-Modus sind durch Token-basierte Authentifizierung geschützt
- System-Proxy-Unterstützung für Unternehmensumgebungen

Details unter [Datenschutz und Sicherheit](https://docs.codeg.app/reference/privacy).

## 👥 Community

- Scannen Sie den unten stehenden QR-Code, um unserer WeChat-Gruppe für Diskussionen, Feedback und Updates beizutreten

<img src="../images/weixin-light.jpg#gh-light-mode-only" alt="WeChat" width="240" />
<img src="../images/weixin-dark.jpg#gh-dark-mode-only" alt="WeChat" width="240" />

- Danke an die [LinuxDO](https://linux.do)-Community für ihre Unterstützung

## 🙏 Danksagungen

- [Agent Client Protocol](https://agentclientprotocol.com) — die Grundlage, auf der Codeg sich mit jedem unterstützten Agenten verbindet
- [Superpowers](https://github.com/obra/superpowers) — unterstützt das Experten-Skills-Modul von Codeg
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — unterstützt den Office-Dokument-Workflow von Codeg
- [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) — unterstützt die wissenschaftlichen Forschungs-Skills von Codeg (MIT-lizenzierte Teilmenge)

## 📜 Lizenz

Apache-2.0. Siehe [LICENSE](../../LICENSE).
