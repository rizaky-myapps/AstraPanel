# AstraPanel : fonctionnement technique

Cette page s'adresse à celles et ceux qui veulent comprendre comment AstraPanel fonctionne, le modifier ou vérifier sa
sécurité. Pour l'installer, suivez le [README](../README.md) ; pour l'utiliser, le [tutoriel](TUTORIEL.md).

## Versions

- **`AstraPanel-Latest`** (branche principale) contient toujours la dernière version. Chaque version est aussi
  conservée sur sa propre branche **`AstraPanel-V.X.Y.Z`**, avec exactement les mêmes fichiers.
- Les versions avancent de 0.0.1 à chaque publication : 1.2.8 → 1.2.9 → 1.3.0 → 1.3.1.
- Les panels installés regardent `AstraPanel-Latest` en continu (toutes les 30 secondes : un `git ls-remote` de
  quelques octets, le `package.json` n'est relu que si le dernier commit change) et lisent la version dans son
  `package.json` : si elle est plus récente, une notification l'annonce aux administrateurs, et un clic dans
  **Paramètres → Mises à jour** l'installe. Avec **Mises à jour automatiques** (réglage `autoUpdate`, désactivé par
  défaut), le panel la demande lui-même au service `astrapanel-update` ; après un échec, la même version n'est
  redemandée que 6 heures plus tard (`state.autoUpdate`).
- Pour publier une version : `./scripts/nouvelle-version.sh` (calcule la version suivante, met à jour
  `package.json`, pousse `AstraPanel-Latest` et crée `AstraPanel-V.X.Y.Z`).

## Fonctionnement

```
                Internet (HTTPS, votre nom de domaine)
                                │
                     ┌──────────▼──────────┐
                     │  Cloudflare (edge)  │
                     └──────────▲──────────┘
                                │ tunnel sortant (aucun port ouvert sur la box)
   ┌────────────────────────────┴────────────────────────────────────────┐
   │ Votre machine (Linux)                                                │
   │   AstraPanel :8080 ── supervise ──► cloudflared, site :4000,         │
   │   (interface + API)                  site :4001, bot Discord…        │
   │   astrapanel-update (root, sur demande) : installe AstraPanel-Latest │
   │   astrapanel-reboot (root, sur demande) : redémarre la machine       │
   └──────────────────────────────────────────────────────────────────────┘
```

- **Serveurs Minecraft** (`src/apps/minecraft.js`) : versions lues sur l'API Fill de PaperMC
  (`fill.papermc.io/v3`) ou le manifeste de Mojang ; Java (Eclipse Temurin, la plus ancienne LTS qui convient : 21
  pour 1.20.5–1.21.x, 25 pour 26.x…) téléchargé depuis l'API d'Adoptium dans `data/runtime/java-<version>` ; serveur
  téléchargé dans `server.jar` avec vérification de l'empreinte (SHA-256 ou SHA-1) ; `eula.txt` et `server-port`
  écrits par le panel. Lancement : `taskset -c 0-<n-1> java -Xms… -Xmx… -XX:ActiveProcessorCount=<n> … -jar
  server.jar --nogui` (`-Dterminal.ansi=true` pour les couleurs). Arrêt : `stop` sur l'entrée standard, puis SIGTERM
  après 60 secondes (`TimeoutStopSec=90` dans le service). Adresses des API modifiables pour les tests :
  `ASTRA_PAPER_API`, `ASTRA_MOJANG_MANIFEST`, `ASTRA_ADOPTIUM_API`.
- **Domaine d'un serveur Minecraft** (`src/tunnel.js`, `syncMinecraft`) : pas d'entrée dans le tunnel (HTTP
  seulement) mais un enregistrement `A` « DNS uniquement » vers l'adresse IPv4 publique (lue sur
  `https://1.1.1.1/cdn-cgi/trace`, modifiable avec `ASTRA_PUBLIC_IP_URL`) et un `SRV` `_minecraft._tcp.<domaine>`
  si le port n'est pas 25565, tous deux commentés « Géré par AstraPanel ». L'adresse publique est relue toutes
  les 5 minutes : si elle change, les enregistrements suivent. Mode « jeton » : enregistrements à créer à la main
  (guide affiché dans le panel).
- Chaque application est un processus lancé par le panel dans son propre groupe de processus (arrêt propre de tout
  l'arbre, `npm start` compris), avec redémarrage automatique et backoff en cas de plantage.
- Les sites reçoivent leur port dans `PORT`. Le tunnel Cloudflare, lancé en même temps que le panel, redirige chaque
  domaine vers le bon port.
- Le panel tourne sans privilèges. Pour se mettre à jour, il crée `data/update-request` : une unité systemd `.path`
  lance alors `astrapanel-update` en root, qui télécharge la branche `AstraPanel-Latest` et relance `install.sh`.
  Même principe pour redémarrer la machine (Paramètres → Hardware) : `data/reboot-request` → `astrapanel-reboot`.
- Interface : JavaScript natif, sans build. Chaque page a son adresse, sans `#` (History API) : `/home`,
  `/apps/<id>/<onglet>`, `/settings/<onglet>`, `/storage/…`, `/aide/…` ; le serveur renvoie `index.html` pour ces
  adresses (`src/http/panel-assets.js`) et `public/js/router.js` affiche la bonne page. Les anciennes adresses
  `/#/…` sont converties.
- Ports de la box (`src/nat/`) : détection de la box et de l'opérateur (`/api_version` de la Freebox, recherche SSDP
  UPnP, nom inverse de l'adresse IP publique), puis redirections tenues à jour toutes les 5 minutes vers l'adresse
  locale de la machine : API Freebox OS (`freebox.js` : autorisation validée sur la box, une seule session
  HMAC-SHA1 gardée et réutilisée — rouverte seulement si la box l'a fermée ou sur « Vérifier » —, `fw/redir/`,
  HTTPS avec les certificats racine de Free `freebox-ca.pem` ; IPv4 partagée : plage de ports de
  `connection/` mémorisée dans `settings.ports.portRange`, seuls ports attribués et acceptés pour les serveurs de
  jeux et les redirections), UPnP IGD (`upnp.js` : SOAP
  `AddPortMapping`…), ou guide manuel. Ports voulus : serveurs de jeux + `settings.ports.rules` ; les redirections du
  panel portent le commentaire « AstraPanel · … », les autres ne sont jamais touchées. Le jeton d'application de la
  Freebox reste dans `db.json`, jamais renvoyé au navigateur.
- Liste des applications : rangée par catégorie (`APP_GROUPS` dans `public/js/ui.js` : bots, sites, serveurs), puis
  dans l'ordre choisi par glisser-déposer (`public/js/sortable.js` : souris, appui long au toucher, Alt + flèches).
  Cet ordre est propre à chaque compte : `prefs.appOrder` (identifiants des applications), enregistré par
  `PATCH /api/account/preferences` ; `sortedApps()` de `public/js/state.js` l'applique partout (panneau latéral,
  tuiles du tableau de bord, recherche).
- Les données sont dans `/opt/astrapanel/data` : `db.json` (configuration), `apps/<id>/` (fichiers des applis),
  `logs/` (journaux avec rotation, couleurs des applications comprises), `metrics.json` et `app-metrics.json`
  (historique des graphiques), `bin/cloudflared`.

## Développement

Node.js 20 ou plus suffit, sans aucun `npm install` :

```bash
npm run dev
```

Le panel démarre sur `http://localhost:8080` avec ses données dans `./data` ; le jeton de première connexion
s'affiche dans le terminal. Variables utiles : `ASTRA_PORT` (ou `PORT`), `ASTRA_DATA_DIR`, `ASTRA_HOST`.

Le panel ne démarre jamais comme application d'un AstraPanel (variable `ASTRA_APP_ID` présente), et un seul panel
tourne par dossier de données (verrou `data/panel.pid`) : voir « Sécurité ».

```bash
npm test
```

```
src/
  server.js          serveur HTTP, routes, arrêt propre
  auth.js            comptes et grades (scrypt), sessions signées, limitation des tentatives
  domains.js         validation des noms de domaine
  tunnel.js          tunnel Cloudflare : cloudflared, API (tunnel, ingress, DNS)
  update.js          suivi de la branche AstraPanel-Latest, demande de mise à jour
  audit.js           journal d'activité (qui a fait quoi, quand)
  hardware.js        informations sur la machine, demande de redémarrage
  version.js         numéros de version (+0.0.1) et noms des branches
  metrics.js         historique CPU / température / RAM (1 h, 12 h, 24 h, 3 j, 7 j)
  storage.js         disques et analyse de l'espace occupé
  system.js          statistiques de la machine
  apps/manager.js    cycle de vie des applis : démarrage, plantages, déploiements
  apps/files.js      opérations sur les fichiers (confinées au dossier de l'app)
  apps/logs.js       journaux en mémoire + fichiers avec rotation
  routes/            API REST (/api/...) et webhook (/hooks/...)
public/              interface web (JavaScript natif, sans build)
runtime/             serveur de fichiers statiques utilisé par les sites statiques
templates/           modèles de départ (bot Discord, site Node.js, site statique), via l'API
deploy/              services systemd, scripts de mise à jour (update.sh) et de redémarrage (reboot.sh)
scripts/             publication d'une nouvelle version (nouvelle-version.sh)
install.sh           installation / mise à jour sur la machine
```

## Sécurité

- Le code du panel appartient à `root` et le service tourne sous l'utilisateur sans privilèges `astrapanel`,
  avec un service systemd durci (`ProtectSystem`, `NoNewPrivileges`).
- Mots de passe hachés avec scrypt, cookies `HttpOnly` + `SameSite=Strict`, protection CSRF, limitation des
  tentatives de connexion, jeton à usage unique pour créer le premier compte.
- Grades : seules les routes d'administration (paramètres, utilisateurs, stockage, mises à jour, tunnel, suppression
  d'applications) sont réservées aux administrateurs. L'accès à chaque application est vérifié côté serveur pour
  toutes ses routes : un utilisateur absent de sa liste reçoit « application introuvable ». Un utilisateur peut tout
  de même exécuter du code via ses applications : ne donnez de compte qu'à des personnes de confiance.
- Le gestionnaire de fichiers ne sort jamais du dossier de l'application et ne suit pas les liens symboliques qui
  pointent ailleurs ; les fichiers affichés en aperçu sont servis avec une politique CSP « sandbox ».
- Le service de mise à jour ne télécharge que le dépôt enregistré à l'installation (fichier appartenant à root) et
  installe toujours `AstraPanel-Latest`. Le service de redémarrage n'accepte qu'une demande du démarrage en cours.
- Journal d'activité : chaque action est enregistrée avec le compte et l'adresse IP, sans mot de passe, jeton ni
  valeur de variable.
- **Un seul panel, jamais lancé par une application.** Une commande `npm start` (ou pnpm, yarn) dans un dossier
  d'application sans `package.json` ferait remonter npm jusqu'au `package.json` du panel (`/opt/astrapanel`) : un
  second panel démarrerait sur les mêmes données et relancerait les applications, donc de nouveau `npm start`… Trois
  garde-fous l'empêchent : le gestionnaire refuse de lancer une commande npm sans `package.json` dans le dossier de
  l'application (et ignore un build npm dans ce cas) ; le panel refuse de démarrer quand `ASTRA_APP_ID` (donnée à
  toutes les applications) est présente, et l'application concernée est alors arrêtée sans relance ; enfin le verrou
  `data/panel.pid` empêche deux panels de tourner sur le même dossier de données.
- **Toutes les applications tournent sous le même utilisateur** : une application peut lire les fichiers des
  autres et la configuration du panel. N'hébergez que du code en lequel vous avez confiance.
- N'ouvrez jamais le port 8080 sur votre box : pour administrer à distance, utilisez le domaine du panel via le
  tunnel Cloudflare, ou un VPN.
