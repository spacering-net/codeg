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
  <a href="./README.de.md">Deutsch</a> |
  <strong>Français</strong> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) est un espace de travail de programmation multi-agents : faites tourner tous vos agents de codage IA au même endroit — et laissez-les travailler ensemble.

Il regroupe les sessions de toutes les CLI d'agents supportées dans un espace de travail unique et consultable, et permet à un agent principal de déléguer à des sous-agents d'autres types au sein d'une même tâche. Le travail que vous préférez ne pas surveiller part sur un tableau de tâches à faire : chaque tâche sur sa propre branche, exécutée sans surveillance, en attente de votre relecture avant d'atterrir. Codeg fonctionne en application de bureau, en serveur autonome ou en conteneur Docker, avec des clients natifs iOS et Android pour les moments où vous n'êtes pas à votre bureau ; quinze agents sont intégrés, et vous pouvez enregistrer vous-même n'importe quel autre agent compatible ACP.

![Espace de travail](../images/workspace-light.png#gh-light-mode-only)
![Espace de travail](../images/workspace-dark.png#gh-dark-mode-only)

## 📖 Documentation

**La documentation complète se trouve sur [docs.codeg.app](https://docs.codeg.app)** — [Démarrage](https://docs.codeg.app/getting-started/) · [Guide](https://docs.codeg.app/guide/) · [Référence](https://docs.codeg.app/reference/)

## 💖 Sponsors

<table>
  <tr>
    <td align="center" width="220">
      <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg" target="_blank"><img src="../images/compshare.png" alt="Compshare" width="160" /></a><br/>
      <strong><a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">Compshare (UCloud)</a></strong>
    </td>
    <td>Merci à Compshare pour son parrainage de ce projet ! Compshare est la plateforme cloud IA d'UCloud, proposant des forfaits Plan d'agents avec modèles nationaux en abonnement mensuel ou à l'usage, à partir de 49 ¥/mois. Elle offre également un accès stable aux modèles étrangers via relais officiel. Compatible avec Claude Code, Codex et les appels d'API. Prête pour l'entreprise : forte concurrence, assistance technique 24h/24 et 7j/7, facturation en libre-service. Les utilisateurs qui s'inscrivent via <a href="https://www.compshare.cn/?ytag=GPU_YY_git_codeg">ce lien</a> reçoivent 5 ¥ de crédits gratuits sur la plateforme !</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://hezu.ink/sign-up?aff=0wVz" target="_blank"><img src="../images/hezu-ink.jpg" alt="合租巴士" width="200" /></a><br/>
      <strong><a href="https://hezu.ink/sign-up?aff=0wVz">合租巴士</a></strong>
    </td>
    <td>Merci à 合租巴士 pour son parrainage de ce projet ! 合租巴士 est une plateforme de relais d'IA fiable et efficace, offrant un relais très stable pour les principaux modèles tels que Codex et Claude Code. Le ratio de recharge est transparent (1:1), avec des subventions de taux Codex dès 0,08. <a href="https://hezu.ink/sign-up?aff=0wVz">Rejoignez le groupe depuis le site officiel pour obtenir 5 USD de crédit d'essai</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://console.lqapi.xyz/sign-up?aff=KPy9" target="_blank"><img src="../images/lq-router.png" alt="LQ router" width="160" /></a><br/>
      <strong><a href="https://console.lqapi.xyz/sign-up?aff=KPy9">LQ router</a></strong>
    </td>
    <td>Merci au service de relais LQ router pour son parrainage de ce projet ! LQ router est un service de relais IA professionnel de niveau entreprise qui offre aux entreprises comme aux développeurs indépendants un accès stable, performant et économique aux API de modèles d'IA. La plateforme prend en charge les principaux modèles, notamment GPT, Claude, Grok et Gemini, avec des coefficients de facturation GPT Pro descendant jusqu'à 0,1×. <a href="https://console.lqapi.xyz/sign-up?aff=KPy9">Rejoignez le groupe depuis le site officiel et recevez 1 USD de crédit d'essai</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://go.apimart.ai/gh-codeg" target="_blank"><img src="../images/apimart-ai.png" alt="APIMart" width="200" /></a><br/>
      <strong><a href="https://go.apimart.ai/gh-codeg">APIMart</a></strong>
    </td>
    <td>Merci à APIMart pour son parrainage de ce projet ! APIMart est une plateforme d'API à bas prix dédiée à la génération d'images et de vidéos par IA : GPT-Image-2 à partir de 0,006 USD l'image, soit plus de 160 images par dollar. Une seule API asynchrone couvre l'image et la vidéo : soumettez une tâche, récupérez un ID, puis obtenez les résultats par interrogation ou par callback. Traitez des dizaines de milliers d'images par lots sans expiration de délai et changez de modèle sans modifier votre code. Paiement à l'usage, sans abonnement mensuel — <a href="https://go.apimart.ai/gh-codeg">inscrivez-vous ici</a> pour commencer.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg" target="_blank"><img src="../images/astraflow.png" alt="UCloud ·星图AstraFlow" width="120" /></a><br/>
      <strong><a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a></strong>
    </td>
    <td>
      <a href="https://www.ucloud.cn/site/active/astraflow?ytag=geo_waituo_codeg">UCloud ·星图AstraFlow</a><br/>
      AstraFlow, la plateforme de grands modèles d'UCloud, donne accès à plus de 200 modèles en un clic : les meilleurs modèles open source — Kimi K3, DeepSeek V4/V3, Qwen 3, GLM5.2, happyhorse — sont intégrés, sans entraînement de votre part et prêts à l'emploi.<br/>
      Inscrivez-vous par <strong>e-mail</strong> via le lien ci-dessus, effectuez la vérification d'identité, puis <a href="https://f.howxm.com/xs/u/HVFW5X8EIYV1">recevez 50 ¥ de crédits de calcul</a>.
    </td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG" target="_blank"><img src="../images/fluxion-ai.png" alt="Fluxion AI" width="160" /></a><br/>
      <strong><a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">Fluxion AI</a></strong>
    </td>
    <td>Merci à Fluxion AI pour son parrainage de ce projet ! Fluxion AI offre un accès API rapide, fiable et économique à GPT, Claude, Gemini et à d'autres modèles d'IA de premier plan via une seule API unifiée. Les nouveaux utilisateurs peuvent recevoir 3 USD de crédits d'API en passant par <a href="https://fluxionai.space/register?source=github&campaign=github-codeg-202609&promo=CODEG">notre lien dédié</a>.</td>
  </tr>
  <tr>
    <td align="center" width="220">
      <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA" target="_blank"><img src="../images/beeapi.jpg" alt="BeeAPI" width="200" /></a><br/>
      <strong><a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a></strong>
    </td>
    <td>Merci à <a href="https://beeapi.ai/signup?aff=HIAB5JCVRNNA">BeeAPI</a> pour son parrainage de ce projet ! BeeAPI est une plateforme professionnelle de relais et d'agrégation d'API d'IA multimodèles, qui réunit de nombreux fournisseurs et les principaux modèles d'IA. Elle prend en charge la comparaison des prix entre fournisseurs, le routage intelligent par groupes ainsi qu'un accès et une facturation unifiés via API, pour appeler les services d'IA de manière plus souple, plus stable et à moindre coût.</td>
  </tr>
</table>

> Vous souhaitez devenir sponsor de Codeg ? [Contactez-nous par e-mail.](mailto:itpkcn@gmail.com)

## 🤖 Agents supportés

Claude Code · Codex · Gemini · OpenClaw · OpenCode · Cline · Hermes · CodeBuddy · Kimi Code · Pi · Grok · Cursor · DeepSeek Harness · Qoder · Google Antigravity

Codeg installe, épingle et met à jour la plupart d'entre eux pour vous. Voir [Agents supportés](https://docs.codeg.app/guide/supported-agents) pour la liste complète, les prérequis d'exécution de chacun et l'emplacement de ses sessions sur le disque.

Pas dans la liste ? Ajoutez-le vous-même. Choisissez un agent dans le registre public ACP ou collez son JSON de distribution : Codeg l'installe, vérifie qu'il démarre et le traite comme un agent intégré — il apparaît dans le sélecteur, accepte la délégation `@` et les skills, et ses conversations sont enregistrées et consultables même quand l'agent ne conserve aucun historique. → [Agents personnalisés](https://docs.codeg.app/guide/custom-agents)

## 🤝 Collaboration multi-agents

La collaboration multi-agents, réduite à une seule touche : tapez `@`, choisissez un agent, envoyez. Codeg s'occupe de l'orchestration — il lance chaque agent mentionné dans sa propre session, lui confie la tâche et renvoie son travail dans le fil où vous êtes déjà. Mentionnez-en deux et ils avancent côte à côte : Claude Code rédige pendant que Codex relit. Aucun changement de contexte, aucun copier-coller entre terminaux.

Et quand un agent lance ses propres sous-agents — Claude Code, Codex, Grok et OpenCode le font tous — chaque enfant a sa carte, qui se remplit pendant qu'il travaille au lieu d'arriver d'un bloc à la fin. Ouvrez-la pour lire la session de l'enfant lui-même.

![Délégation d'une tâche à des sous-agents depuis une seule conversation Codeg](../images/collaboration-light.gif#gh-light-mode-only)
![Délégation d'une tâche à des sous-agents depuis une seule conversation Codeg](../images/collaboration-dark.gif#gh-dark-mode-only)

## ✅ Tâches à faire

Tout travail n'exige pas que vous le regardiez. Notez-le — un titre, une description, l'agent qui doit l'exécuter — et Codeg lui confie **sa propre copie du code** : un worktree git à côté de votre projet, sur sa propre branche. Plusieurs tournent à la fois sans se toucher, ni toucher l'arbre dans lequel vous travaillez. Programmez-en une pour ce soir, ou laissez un dossier vider sa file tout seul, dans la limite de parallélisme que vous fixez.

Une tâche terminée ne se fusionne pas toute seule. Elle passe dans la colonne de relecture et attend : lisez le diff, renvoyez-la pour un tour de plus, ou acceptez-la — et c'est l'agent qui la fait atterrir, en ramenant d'abord votre branche de base dans son worktree et en y résolvant les conflits. Ensuite Codeg ne le croit pas sur parole : il vérifie git lui-même, et une fusion qu'il ne peut pas confirmer retourne en relecture au lieu d'annoncer un succès.

![Le tableau des tâches à faire, où les tâches passent de À faire à En cours puis à Terminé](../images/task-light.png#gh-light-mode-only)
![Le tableau des tâches à faire, où les tâches passent de À faire à En cours puis à Terminé](../images/task-dark.png#gh-dark-mode-only)

## 🪟 Vue divisée

Une seule barre d'onglets ne suffit pas toujours. Faites un clic droit sur un onglet de conversation pour diviser la vue **à droite** ou **vers le bas**, autant de fois que vous voulez : deux volets côte à côte, une pile de trois, une grille. Chaque groupe est un espace de travail à part entière — ses onglets, son en-tête, son propre bouton de nouvelle conversation — Claude Code peut donc refactoriser dans un volet pendant que Codex relit un diff dans le suivant.

Faites glisser un onglet d'un groupe à l'autre : sa session continue de streamer pendant le déménagement. Faites glisser la séparation entre deux groupes pour changer le partage de l'espace. Votre disposition est mémorisée par espace de travail, brouillons compris : rouvrez Codeg et la division revient, avec le texte jamais envoyé toujours dans le champ.

![Division de la zone de conversation en une grille de groupes d'onglets](../images/split-light.gif#gh-light-mode-only)
![Division de la zone de conversation en une grille de groupes d'onglets](../images/split-dark.gif#gh-dark-mode-only)

## 📄 Documents Office

Demandez une présentation, un rapport ou un classeur : l'agent produit un vrai `.pptx` / `.docx` / `.xlsx` — pendant que le volet de droite le rend en direct. Chaque modification arrive d'elle-même dans l'aperçu : les diapositives se remplissent, les tableaux prennent forme, les chiffres se posent dans les cellules. La diapositive 4 ne vous plaît pas ? Dites-le au message suivant — l'agent modifie le même fichier sur place et l'aperçu suit. Aucun export, aucune application Office externe, aucune sortie de Codeg.

![Un agent modifiant un document Office à côté de son aperçu en direct](../images/office-light.png#gh-light-mode-only)
![Un agent modifiant un document Office à côté de son aperçu en direct](../images/office-dark.png#gh-dark-mode-only)

## 💻 Espace de travail

Un seul espace de travail, tous les agents. Quel que soit celui qui travaille — Claude Code, Codex, Cursor —, il le fait dans le même éditeur, avec les mêmes diffs en direct et le même client git ; et ce qu'il produit, ce sont de vrais fichiers de votre dépôt, qui changent sous vos yeux. Rattachez d'autres répertoires — une bibliothèque partagée, un service voisin, le dépôt de documentation — et l'arborescence, la recherche et l'agent lui-même les traitent comme un seul espace de travail.

**Sessions.** Récupérez l'historique que vous avez déjà : les sessions passées de tous les agents installés, importées en un clic et reprenables là où vous les aviez laissées. Une fois dedans, elles cessent d'être des silos séparés — mentionnez une ancienne session avec `@` et l'agent auquel vous parlez peut la lire, même si un autre agent l'a écrite ; l'exécution Codex d'aujourd'hui repart donc de là où la session Claude Code de la semaine dernière s'est arrêtée. Aussi longue que devienne une conversation, elle s'ouvre sur ses derniers tours et charge le reste au fur et à mesure que vous remontez.

**Fichiers.** Les modifications de l'agent apparaissent sous forme de diffs à côté de la conversation, au fur et à mesure. Ouvrez n'importe quel fichier dans un vrai éditeur avec coloration syntaxique, envoyez un fichier — ou juste une sélection — directement à l'agent avec `⌘L`, et prévisualisez Markdown, HTML, images et documents Office dans le même volet.

**Git.** Un client complet, pas un simple indicateur d'état : committez directement depuis l'onglet Modifications — un message, Entrée — avec pull, fetch, push et remise à côté, et un historique qui montre quels commits sont poussés. Créez des branches, fusionnez, rebasez, réinitialisez ou comparez avec une autre branche, et mettez à jour ou poussez n'importe quelle branche sans basculer dessus. Les conflits ouvrent un éditeur de fusion à trois volets où vous acceptez bloc par bloc ou tapez vous-même la résolution. Et les worktrees réduisent le travail en parallèle à une seule action — une nouvelle branche, son propre répertoire et une conversation toute neuve enracinée dedans, pour qu'une flotte d'agents construise des fonctionnalités différentes en même temps sans se marcher sur les fichiers.

**Quand ça se passe mal.** Un tour qui échoue ne dit pas seulement que quelque chose a raté : sur Claude Code et Codex, il en nomme le type — problème de connexion, problème d'accès, limite atteinte, requête refusée, problème de service — et accroche sous le compositeur un bandeau ne portant que ce qui aiderait vraiment : Réessayer, Se connecter ou une nouvelle session. Les tentatives que l'agent fait de lui-même s'affichent en ambre et se résument en une seule ligne « Rétabli ». Et l'indicateur de connexion sous le compositeur est un bouton : cliquez pour connaître l'état réel de la session, avec une Reconnexion qui reprend au lieu de repartir de zéro.

## 📱 iPhone, iPad et Android

Quittez votre bureau, pas votre travail. Les clients natifs iOS et Android se connectent au Codeg que vous faites déjà tourner — le **Service web** de votre application de bureau, ou votre propre `codeg-server` — et de là vous lancez des sessions, suivez en direct les réponses et les appels d'outils, répondez aux demandes d'autorisation et parcourez projets et branches. Rien ne migre sur le téléphone : vos fichiers, les CLI des agents et les conversations restent sur la machine qui exécute Codeg, et le jeton d'accès est gardé dans le Trousseau iOS ou protégé par Android Keystore. Les deux clients sont open source ([iOS](https://github.com/xintaofei/codeg-ios), [Android](https://github.com/xintaofei/codeg-android)) ; l'appairage tient en trois étapes, détaillées dans [Applications mobiles](https://docs.codeg.app/getting-started/installation#mobile-apps).

| iPhone et iPad | Android |
| :---: | :---: |
| <img src="../images/mobile-ios.jpg" alt="Démarrage d'une session depuis le client Codeg pour iOS" width="248" /> | <img src="../images/mobile-android.jpg" alt="La réponse d'un agent qui arrive en direct dans le client Codeg pour Android" width="248" /> |

## ✨ Points forts

- **[Agrégation des conversations](https://docs.codeg.app/guide/aggregation)** — importez les sessions de tous les agents supportés dans un espace de travail unifié et consultable, et reprenez-les là où vous vous étiez arrêté
- **[Collaboration multi-agents](https://docs.codeg.app/guide/multi-agent)** — mentionnez un agent avec `@` pour déléguer : les sous-agents de types différents s'exécutent chacun dans sa session, en parallèle, au sein d'une même tâche
- **[Tâches à faire](https://docs.codeg.app/guide/tasks)** — notez ce qu'il y a à faire et les agents vident la file, chaque tâche dans son propre worktree, pour n'atterrir sur votre branche qu'après votre relecture
- **[Agents personnalisés](https://docs.codeg.app/guide/custom-agents)** — enregistrez n'importe quel autre agent compatible ACP depuis le registre public ou son JSON de distribution ; Codeg l'installe, enregistre son historique et le traite comme un agent intégré
- **[L'espace de travail](https://docs.codeg.app/guide/workspace)** — toute la boucle d'ingénierie à côté de l'agent : arborescence, éditeur et diff, changements git, commit, terminal intégré et [plusieurs dossiers réunis en un seul espace de travail](https://docs.codeg.app/guide/workspace#work-across-several-folders)
- **[Vue divisée](https://docs.codeg.app/guide/workspace#split-the-conversation-view-into-groups)** — divisez la zone de conversation en autant de groupes d'onglets que vous voulez, faites glisser onglets et séparations entre eux, et retrouvez la disposition — brouillons compris — au redémarrage
- **[Git et worktrees](https://docs.codeg.app/guide/git)** — relisez et validez vos changements, gérez vos comptes Git distants et travaillez en parallèle grâce aux flux `git worktree` intégrés
- **[Utilisation des tokens](https://docs.codeg.app/guide/token-usage)** — derrière le compteur de la barre d'état, un rapport complet : tendances et taux de succès du cache, carte de chaleur d'activité, et répartitions par dossier, agent, modèle et session
- **[Canaux de discussion](https://docs.codeg.app/guide/chat-channels)** — pilotez vos agents depuis Telegram, Lark (Feishu) et WeChat : créez des tâches, approuvez des permissions, suivez l'avancement en direct
- **[Automatisations](https://docs.codeg.app/guide/automations)** — enregistrez un compositeur entièrement configuré comme une automatisation réutilisable, exécutée sans interface, selon un planning cron ou à la demande — en lançant une session, ou en déposant une tâche à faire que vous relirez plus tard
- **[Documents Office](https://docs.codeg.app/guide/office)** — créez, analysez, relisez et modifiez des `.docx` / `.xlsx` / `.pptx` via l'`officecli` intégré, avec aperçu en direct dans l'onglet
- **[Recherche scientifique](https://docs.codeg.app/guide/research)** — des compétences de recherche intégrées (formulation d'hypothèses, plan d'expérience, statistiques, visualisation, évaluation critique, recherche bibliographique) que n'importe quel agent peut invoquer
- **[Project Boot](https://docs.codeg.app/guide/project-boot)** — créez visuellement de nouveaux projets, avec aperçu en direct, puis ouvrez-les directement dans l'espace de travail
- **[MCP](https://docs.codeg.app/guide/mcp) & [Skills](https://docs.codeg.app/guide/skills)** — scan des serveurs locaux, recherche et installation depuis le registre, et compétences gérées au niveau global ou projet
- **[À votre image](https://docs.codeg.app/reference/settings/appearance)** — recolorez n'importe lequel des douze thèmes token par token, réglez l'arrondi des angles pour toute l'app, importez et exportez des thèmes en JSON shadcn, ou écrivez votre propre CSS
- **[Bureau, serveur et Docker](https://docs.codeg.app/getting-started/deployment)** — une application de bureau native, un `codeg-server` autonome accessible depuis n'importe quel navigateur, ou `docker compose up`
- **[iPhone, iPad et Android](https://docs.codeg.app/getting-started/installation#mobile-apps)** — des clients mobiles natifs reliés à votre poste ou à votre serveur : lancez des sessions, recevez les réponses en flux, approuvez les permissions et parcourez vos projets où que vous soyez

## 📦 Installation et exécution

**Bureau** — téléchargez l'installateur macOS, Windows ou Linux depuis les [Releases](https://github.com/xintaofei/codeg/releases), puis suivez l'[Installation](https://docs.codeg.app/getting-started/installation).

**Serveur** — faites tourner Codeg sans interface et accédez-y depuis n'importe quel navigateur. Sous Linux ou macOS :

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
CODEG_STATIC_DIR=/usr/local/share/codeg/web codeg-server
```

Sous Windows, dans PowerShell :

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
$env:CODEG_STATIC_DIR="$env:LOCALAPPDATA\codeg\web"; codeg-server
```

**Docker** — le même serveur, dans un conteneur :

```bash
docker run -d -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

**Mobile** — installez l'[app iOS](https://apps.apple.com/app/codeg-client/id6785199071) ou l'[APK Android](https://github.com/xintaofei/codeg-android/releases/latest), puis pointez-la vers le **Service web** de votre application de bureau ou vers votre propre `codeg-server` : URL, jeton, c'est prêt. Les étapes d'appairage sont dans [Applications mobiles](https://docs.codeg.app/getting-started/installation#mobile-apps).

Compose, binaires précompilés, compilation depuis les sources et mises à jour sur place sont traités dans [Déploiement](https://docs.codeg.app/getting-started/deployment) ; les variables d'environnement dans [Configuration](https://docs.codeg.app/getting-started/configuration). Pour compiler Codeg lui-même : [Développement](https://docs.codeg.app/reference/development) et [Architecture](https://docs.codeg.app/reference/architecture).

## 🔒 Confidentialité et sécurité

- Local d'abord par défaut pour l'analyse, le stockage et les opérations sur les projets — les accès réseau n'ont lieu que sur des actions que vous déclenchez
- Les modes web et serveur sont protégés par une authentification par jeton
- Prise en charge du proxy système pour les environnements d'entreprise

Détails dans [Confidentialité et sécurité](https://docs.codeg.app/reference/privacy).

## 👥 Communauté

- Scannez le QR code ci-dessous pour rejoindre notre groupe WeChat pour des discussions, des retours et des mises à jour

<img src="../images/weixin-light.jpg#gh-light-mode-only" alt="WeChat" width="240" />
<img src="../images/weixin-dark.jpg#gh-dark-mode-only" alt="WeChat" width="240" />

- Merci à la communauté [LinuxDO](https://linux.do) pour son soutien

## 🙏 Remerciements

- [Agent Client Protocol](https://agentclientprotocol.com) — le socle qui permet à Codeg de se connecter à tous les agents qu'il supporte
- [Superpowers](https://github.com/obra/superpowers) — alimente le module de compétences d'experts de Codeg
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — alimente le flux de travail des documents Office de Codeg
- [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) — alimente les compétences de Recherche scientifique de Codeg (sous-ensemble sous licence MIT)

## 📜 Licence

Apache-2.0. Voir [LICENSE](../../LICENSE).
