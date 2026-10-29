# Tutoriel : héberger vos sites et bots Discord sur un Raspberry Pi 5 avec AstraPanel

Ce guide part de zéro : vous préparez la carte SD, installez AstraPanel, lancez votre premier bot Discord et votre
premier site, puis mettez le tout en ligne avec votre nom de domaine en HTTPS. Comptez environ une heure.

## Sommaire

1. [Ce dont vous avez besoin](#1-ce-dont-vous-avez-besoin)
2. [Installer Raspberry Pi OS](#2-installer-raspberry-pi-os)
3. [Se connecter au Pi en SSH](#3-se-connecter-au-pi-en-ssh)
4. [Donner une adresse IP fixe au Pi](#4-donner-une-adresse-ip-fixe-au-pi)
5. [Installer AstraPanel](#5-installer-astrapanel)
6. [Première connexion au panel](#6-première-connexion-au-panel)
7. [Héberger un bot Discord](#7-héberger-un-bot-discord)
8. [Héberger un site web](#8-héberger-un-site-web)
9. [Mettre vos sites en ligne sur Internet](#9-mettre-vos-sites-en-ligne-sur-internet)
10. [Déploiement automatique depuis GitHub](#10-déploiement-automatique-depuis-github)
11. [Sécuriser le Raspberry Pi](#11-sécuriser-le-raspberry-pi)
12. [Entretien : mises à jour, sauvegardes, journaux](#12-entretien--mises-à-jour-sauvegardes-journaux)
13. [Dépannage](#13-dépannage)

---

## 1. Ce dont vous avez besoin

| Élément | Recommandation |
| --- | --- |
| Raspberry Pi 5 | 4 Go de RAM conviennent très bien pour plusieurs bots et sites. 2 Go suffisent pour quelques bots, 8 Go si vous hébergez beaucoup de sites. |
| Alimentation | **L'alimentation officielle 27 W USB-C (5 V / 5 A).** Avec un chargeur de téléphone, le Pi 5 se met en sous-tension, ralentit et peut planter. |
| Refroidissement | L'**Active Cooler** officiel (ou un boîtier ventilé) : le Pi tourne 24 h/24. |
| Stockage | Une carte microSD **A2** de 32 Go minimum, ou mieux un **SSD NVMe** avec le M.2 HAT+ (plus rapide et plus fiable pour un serveur). |
| Réseau | Un câble Ethernet relié à votre box (plus stable que le Wi-Fi). |
| Un ordinateur | Pour préparer la carte SD et vous connecter au Pi. |

Pour la mise en ligne (étape 9), il vous faudra aussi un **nom de domaine** (quelques euros par an chez OVHcloud,
Gandi, Infomaniak, Cloudflare…) ou un sous-domaine gratuit.

## 2. Installer Raspberry Pi OS

1. Téléchargez et installez **Raspberry Pi Imager** depuis [raspberrypi.com/software](https://www.raspberrypi.com/software/).
2. Insérez la carte microSD (ou le SSD dans un adaptateur USB) dans votre ordinateur et lancez Imager.
3. Choisissez :
   - **Appareil** : Raspberry Pi 5
   - **Système d'exploitation** : *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**
     (la version Lite, sans bureau, laisse plus de RAM à vos applications ; la version Desktop fonctionne aussi)
   - **Stockage** : votre carte SD
4. Quand Imager propose de **personnaliser** l'image, renseignez :
   - **Nom d'hôte** : `astrapanel` (le Pi sera joignable à l'adresse `astrapanel.local`)
   - **Nom d'utilisateur et mot de passe** : par exemple `pi` et un mot de passe solide
   - **Wi-Fi** : seulement si vous n'utilisez pas de câble Ethernet
   - **Fuseau horaire** : `Europe/Paris`, **clavier** : `fr`
   - **SSH** : activez-le (authentification par mot de passe, ou par clé publique si vous en avez une)
5. Lancez l'écriture, puis insérez la carte dans le Pi, branchez le câble Ethernet et l'alimentation.

Le premier démarrage prend une à deux minutes.

## 3. Se connecter au Pi en SSH

Depuis votre ordinateur, ouvrez un terminal (sous Windows : **Terminal** ou **PowerShell**, la commande `ssh` est
incluse) :

```bash
ssh pi@astrapanel.local
```

Remplacez `pi` par le nom d'utilisateur choisi. Acceptez l'empreinte de sécurité (`yes`) puis tapez votre mot de passe.

> Si `astrapanel.local` ne répond pas, trouvez l'adresse IP du Pi dans l'interface de votre box (liste des
> appareils connectés) et utilisez `ssh pi@192.168.1.XX`.

Mettez le système à jour puis redémarrez :

```bash
sudo apt update && sudo apt full-upgrade -y
```

```bash
sudo reboot
```

Attendez une minute et reconnectez-vous en SSH.

## 4. Donner une adresse IP fixe au Pi

Votre box doit toujours attribuer la même adresse au Pi, sinon la redirection de ports (étape 9) cessera de
fonctionner après un redémarrage.

**Méthode conseillée : un bail DHCP statique dans votre box.** Dans l'interface de votre box (Freebox, Livebox,
Bbox, Box SFR…), cherchez la rubrique **DHCP** puis **baux statiques** (ou « attribution d'adresse IP fixe ») et
associez une adresse au Pi (repérable par son nom `astrapanel`).

**Autre méthode : configurer l'IP sur le Pi** (Raspberry Pi OS utilise NetworkManager). Repérez le nom de la connexion :

```bash
nmcli connection show
```

Puis adaptez cette commande (nom de la connexion, adresse voulue, adresse de la box) :

```bash
sudo nmcli connection modify "Wired connection 1" ipv4.method manual ipv4.addresses 192.168.1.50/24 ipv4.gateway 192.168.1.1 ipv4.dns "1.1.1.1 9.9.9.9"
```

```bash
sudo nmcli connection up "Wired connection 1"
```

Choisissez une adresse hors de la plage distribuée automatiquement par votre box. Votre session SSH sera coupée :
reconnectez-vous avec la nouvelle adresse.

## 5. Installer AstraPanel

Toujours en SSH sur le Pi :

```bash
sudo apt install -y git
```

```bash
git clone https://github.com/rizaky-myapps/AstraPanel.git
```

```bash
cd AstraPanel
```

```bash
sudo ./install.sh --with-caddy
```

> **Dépôt privé ?** Si le dépôt GitHub est privé, `git clone` demandera un identifiant : utilisez votre nom
> d'utilisateur GitHub et, comme mot de passe, un *personal access token* (GitHub → Settings → Developer settings
> → Personal access tokens).

Le script, qui prend quelques minutes :

- installe git, unzip et les outils de compilation (nécessaires à certains modules npm de bots, comme ceux pour la voix) ;
- installe **Node.js 24 LTS** si aucune version récente n'est présente ;
- crée l'utilisateur système `astrapanel`, qui fera tourner le panel et vos applications sans droits administrateur ;
- copie le panel dans `/opt/astrapanel` et crée le service `astrapanel` qui démarre avec le Pi ;
- avec `--with-caddy` : installe **Caddy**, le serveur qui gérera vos noms de domaine et le HTTPS (étape 9).
  Vous pouvez l'omettre si vous voulez seulement utiliser vos sites sur votre réseau local, ou si vous choisissez le
  tunnel Cloudflare de l'étape 9.

À la fin, le script affiche l'adresse du panel et un **jeton d'installation** :

```
✔ AstraPanel est installé et démarré !

  Adresse du panel : http://192.168.1.50:8080
                     http://astrapanel.local:8080

  Jeton d'installation (à saisir à la première connexion) : Xy3k9QpL2mWa
```

> Options du script : `--port=9000` change le port du panel (8080 par défaut). Vous pouvez relancer le script à
> tout moment, par exemple pour ajouter Caddy plus tard : vos applications sont conservées.

## 6. Première connexion au panel

1. Sur votre ordinateur (ou votre téléphone, connecté au même réseau), ouvrez **http://astrapanel.local:8080**.
2. Saisissez le **jeton d'installation**. Si vous l'avez perdu, affichez-le sur le Pi :

   ```bash
   sudo cat /opt/astrapanel/data/setup-token
   ```

3. Choisissez votre nom d'utilisateur et un mot de passe solide (8 caractères minimum).

Vous arrivez sur le **tableau de bord** : charge du processeur, température, mémoire, espace disque et la liste de
vos applications. Si le panel affiche « Sous-tension détectée », changez d'alimentation (voir étape 1).

![Tableau de bord](images/tableau-de-bord.png)

## 7. Héberger un bot Discord

### 7.1 Créer le bot sur Discord

1. Allez sur le [portail développeur Discord](https://discord.com/developers/applications) et cliquez sur
   **New Application**. Donnez-lui un nom.
2. Dans l'onglet **Bot**, cliquez sur **Reset Token** et copiez le token affiché.
   **Ce token est un mot de passe** : ne le publiez jamais (ni sur GitHub, ni sur Discord).
3. Le modèle d'AstraPanel utilise uniquement les commandes slash et n'a besoin d'aucun *intent* privilégié. Si votre
   propre bot lit le contenu des messages, activez **Message Content Intent** dans ce même onglet.
4. Invitez le bot sur votre serveur : onglet **OAuth2** → **URL Generator**, cochez les scopes **bot** et
   **applications.commands**, puis les permissions utiles (au minimum *View Channels* et *Send Messages*). Ouvrez l'URL générée et
   choisissez votre serveur.

### 7.2 Lancer le bot d'exemple

1. Dans AstraPanel, cliquez sur **Nouvelle application**.
2. Type : **Bot Discord**. Source : **Modèle de départ**.
3. Donnez-lui un nom, puis dans **Variables d'environnement**, collez votre token comme valeur de `DISCORD_TOKEN`.
4. Laissez cochés « Redémarrage automatique » et « Démarrer après la création », puis cliquez sur **Créer l'application**.

La console s'ouvre : le panel installe discord.js (`npm install`, environ une minute sur le Pi) puis démarre le bot.
Vous devez voir :

```
✅ Connecté en tant que MonBot#1234 sur 1 serveur(s)
📝 2 commandes slash enregistrées
```

Sur Discord, tapez `/ping` : le bot répond. 🎉

La commande **`/text`** fait parler le bot : `/text message:Bonjour à tous !` envoie le message dans le salon
actuel, et l'option `salon` permet d'en choisir un autre. Écrivez `\n` pour aller à la ligne. Par sécurité :

- seuls les membres qui ont la permission **Gérer les messages** voient la commande (un administrateur peut changer
  ça dans **Paramètres du serveur → Intégrations → votre bot**) ;
- les mentions `@everyone`, `@here` et de rôles sont désactivées dans les messages envoyés par `/text` ;
- le bot doit avoir le droit d'écrire dans le salon choisi, sinon il vous le signale.

Pour modifier le bot, ouvrez l'onglet **Fichiers**, cliquez sur `index.js`, éditez puis **Enregistrer** (ou Ctrl+S),
et cliquez sur **Redémarrer**.

### 7.3 Héberger votre propre bot

**Depuis GitHub** : Nouvelle application → Bot Discord → **Dépôt Git**, collez l'URL du dépôt (et la branche si ce
n'est pas celle par défaut).

**Depuis votre ordinateur** : compressez le dossier du projet en `.zip` **sans le dossier `node_modules`**, puis
Nouvelle application → Bot Discord → **Archive ZIP**.

Dans les deux cas :

- **Commande de démarrage** : la commande que vous tapez d'habitude, par exemple `node index.js` ou `npm start`
  (`node index.js` consomme un peu moins de mémoire).
- **Variables d'environnement** : mettez-y le token et vos autres secrets. Dans votre code, lisez-les avec
  `process.env.DISCORD_TOKEN`. Si votre projet utilise un fichier `.env` avec le paquet `dotenv`, vous pouvez coller
  son contenu en « Mode texte (.env) » : les variables définies dans le panel sont prioritaires.
- Le panel lance `npm install` puis démarre le bot. Les dépendances sont réinstallées à chaque déploiement.

**Bot musical / vocal** : installez ffmpeg sur le Pi, puis redéployez le bot :

```bash
sudo apt install -y ffmpeg
```

## 8. Héberger un site web

AstraPanel attribue un **port** à chaque site (4000, 4001…) et le transmet dans la variable d'environnement `PORT`.
Sur votre réseau local, le site est accessible à l'adresse `http://astrapanel.local:<port>` : le bouton **Ouvrir**
de la fiche de l'application vous y emmène.

### 8.1 Site Node.js (Express, Fastify, Next.js…)

Votre serveur **doit écouter sur le port fourni par le panel** :

```js
import express from 'express';

const app = express();
app.get('/', (req, res) => res.send('Bonjour depuis mon Raspberry Pi !'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Site en ligne sur le port ${port}`));
```

Créez l'application avec le type **Site Node.js** et la source de votre choix (modèle, Git, ZIP). Exemples de réglages :

| Projet | Commande de démarrage | Commande de build |
| --- | --- | --- |
| Express / Fastify | `node server.js` (ou `npm start`) | — |
| Next.js | `npm start` | `npm run build` |
| Nuxt | `node .output/server/index.mjs` | `npm run build` |

### 8.2 Site statique (HTML, React, Vue, Vite…)

Choisissez le type **Site statique** :

- **HTML / CSS / JS simple** : laissez « Dossier à servir » sur `.` (la racine du projet).
- **Projet avec build** (Vite, React, Vue, Astro…) : commande de build `npm run build`, dossier à servir `dist`
  (ou `build` selon l'outil). Cochez **Application monopage (SPA)** si votre site utilise un routeur côté client.

Une page `404.html` à la racine du dossier servi est utilisée pour les pages introuvables. Les fichiers et dossiers
cachés (`.git`, `.env`…) ne sont jamais servis.

## 9. Mettre vos sites en ligne sur Internet

Deux solutions au choix :

- **Option A : Caddy + redirection de ports.** Tout reste chez vous, HTTPS automatique avec Let's Encrypt.
  Il faut pouvoir ouvrir les ports 80 et 443 de votre box.
- **Option B : tunnel Cloudflare.** Aucun port à ouvrir et fonctionne même si votre connexion n'a pas d'IPv4
  publique, mais le trafic passe par Cloudflare et votre domaine doit y être géré.

### Option A : nom de domaine + Caddy

Prérequis : avoir lancé l'installateur avec `--with-caddy` (sinon relancez `sudo ./install.sh --with-caddy`).

1. **Trouvez votre IP publique** depuis le Pi :

   ```bash
   curl -4 ifconfig.me
   ```

   Beaucoup de box françaises ont une IPv4 fixe, mais pas toutes. Si la vôtre change, utilisez un service de DNS
   dynamique (par exemple [DuckDNS](https://www.duckdns.org), gratuit). Chez Free, si les ports 80 et 443 ne sont pas
   disponibles, demandez une « IPv4 full-stack » dans votre espace abonné.

2. **Configurez le DNS** chez votre registrar : créez un enregistrement **A** pour `monsite.fr` (et un pour
   `www.monsite.fr`) qui pointe vers votre IP publique. Ajoutez aussi `panel.monsite.fr` si vous voulez accéder au
   panel depuis l'extérieur. La propagation prend de quelques minutes à quelques heures.

3. **Ouvrez les ports dans votre box** : dans la rubrique **NAT / PAT** ou **redirection de ports**, redirigez les
   ports TCP **80** et **443** vers l'adresse IP du Pi (étape 4). **N'ouvrez pas le port 8080.**

4. **Associez le domaine au site** : dans AstraPanel, ouvrez l'application → onglet **Paramètres** → champ
   **Nom(s) de domaine** : `monsite.fr, www.monsite.fr` → **Enregistrer**. Le panel met à jour Caddy, qui obtient le
   certificat HTTPS en moins d'une minute.

5. **Accès au panel en HTTPS** (facultatif) : menu **Paramètres** → **Domaine du panel** : `panel.monsite.fr` →
   **Enregistrer**. Vous pourrez alors administrer vos applications depuis n'importe où via `https://panel.monsite.fr`.

Testez depuis votre téléphone en 4G/5G (Wi-Fi coupé) : `https://monsite.fr` doit s'afficher avec le cadenas.

> Le menu **Paramètres** du panel indique si Caddy est installé et affiche la configuration générée. En cas
> d'erreur, le message de Caddy s'y affiche aussi.

### Option B : tunnel Cloudflare

1. Ajoutez votre domaine à un compte [Cloudflare](https://dash.cloudflare.com) (offre gratuite) et changez les
   serveurs DNS chez votre registrar comme Cloudflare l'indique.
2. Dans le tableau de bord Cloudflare, ouvrez **Zero Trust**, puis la section **Networks → Tunnels**, et créez un
   tunnel de type *Cloudflared*. Choisissez l'environnement **Debian**, architecture **arm64**, et exécutez sur le Pi
   les commandes affichées (installation de `cloudflared`, puis `sudo cloudflared service install <jeton>`).
3. Dans l'onglet **Public Hostnames** du tunnel, ajoutez une entrée par site :
   - `monsite.fr` → service `HTTP` → `localhost:4000` (le port de l'application dans AstraPanel)
   - `panel.monsite.fr` → service `HTTP` → `localhost:8080` (facultatif ; protégez-le avec Cloudflare Access)

Avec cette option, laissez le champ « Nom(s) de domaine » vide dans AstraPanel : le HTTPS est géré par Cloudflare.

## 10. Déploiement automatique depuis GitHub

Pour qu'un `git push` mette automatiquement le site ou le bot à jour :

1. L'application doit avoir un **dépôt Git** configuré (onglet **Déploiement**).
2. Le panel doit être joignable depuis Internet (domaine du panel de l'option A, ou tunnel de l'option B).
3. Dans l'onglet **Déploiement**, copiez l'**adresse du webhook**.
4. Sur GitHub : dépôt → **Settings** → **Webhooks** → **Add webhook**
   - *Payload URL* : l'adresse copiée
   - *Content type* : `application/json`
   - *Which events* : **Just the push event**

À chaque push sur la branche suivie, AstraPanel récupère le code, réinstalle les dépendances, lance le build et
redémarre l'application. Vous suivez le tout dans la console. Le bouton **Déployer maintenant** fait la même chose
à la demande.

**Dépôts privés**, deux possibilités :

- un *fine-grained personal access token* GitHub limité au dépôt, avec la permission **Contents : Read-only**,
  placé dans l'URL : `https://<token>@github.com/moi/mon-bot.git` ;
- ou une **clé de déploiement SSH**. Créez-la sur le Pi :

  ```bash
  sudo -u astrapanel mkdir -p -m 700 /opt/astrapanel/data/.ssh
  ```

  ```bash
  sudo -u astrapanel ssh-keygen -t ed25519 -N "" -f /opt/astrapanel/data/.ssh/id_ed25519
  ```

  ```bash
  sudo cat /opt/astrapanel/data/.ssh/id_ed25519.pub
  ```

  Ajoutez la clé affichée dans GitHub (dépôt → Settings → **Deploy keys**) et utilisez l'URL SSH du dépôt :
  `git@github.com:moi/mon-bot.git`.

## 11. Sécuriser le Raspberry Pi

- **Panel** : mot de passe solide, et **jamais de redirection du port 8080** sur la box. Pour administrer à
  distance : domaine du panel en HTTPS, tunnel Cloudflare, ou un VPN comme Tailscale ou WireGuard.
- **Code hébergé** : toutes les applications tournent sous le même utilisateur `astrapanel`. Une application peut donc
  lire les fichiers des autres, y compris leurs tokens. N'hébergez que du code en lequel vous avez confiance.
- **Pare-feu** : `ufw` n'autorise que le nécessaire. Adaptez `192.168.1.0/24` à votre réseau local :

  ```bash
  sudo apt install -y ufw
  ```

  ```bash
  sudo ufw allow OpenSSH
  ```

  ```bash
  sudo ufw allow 80,443/tcp
  ```

  ```bash
  sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
  ```

  ```bash
  sudo ufw allow from 192.168.1.0/24 to any port 4000:4999 proto tcp
  ```

  ```bash
  sudo ufw enable
  ```

- **Mises à jour de sécurité automatiques** :

  ```bash
  sudo apt install -y unattended-upgrades
  ```

- **SSH** : préférez une connexion par clé (`ssh-copy-id pi@astrapanel.local` depuis un ordinateur Linux ou macOS), puis
  désactivez l'authentification par mot de passe dans `/etc/ssh/sshd_config` (`PasswordAuthentication no`).

## 12. Entretien : mises à jour, sauvegardes, journaux

**Mettre à jour AstraPanel** (vos applications sont conservées et redémarrées automatiquement) :

```bash
cd ~/AstraPanel && git pull && sudo ./install.sh
```

**Journaux du panel** :

```bash
sudo journalctl -u astrapanel -f
```

Les journaux de chaque application sont dans la console du panel (bouton **Télécharger** pour le fichier complet) et
dans `/opt/astrapanel/data/logs/`.

**Sauvegarder** applications, configuration et comptes :

```bash
sudo tar czf ~/astrapanel-$(date +%F).tar.gz -C /opt/astrapanel data
```

Copiez ensuite l'archive ailleurs que sur le Pi (`scp pi@astrapanel.local:astrapanel-*.tar.gz .` depuis votre
ordinateur). Pour **restaurer** sur un Pi où AstraPanel est installé :

```bash
sudo systemctl stop astrapanel
```

```bash
sudo tar xzf astrapanel-AAAA-MM-JJ.tar.gz -C /opt/astrapanel
```

```bash
sudo chown -R astrapanel:astrapanel /opt/astrapanel/data && sudo systemctl start astrapanel
```

**Mot de passe oublié** :

```bash
sudo astrapanel-cli reset-password admin
```

**Désinstaller** (vos données restent dans `/opt/astrapanel/data`, ajoutez `--purge` pour tout supprimer) :

```bash
sudo ./uninstall.sh
```

## 13. Dépannage

**Le panel ne s'affiche pas.** Vérifiez qu'il tourne et lisez ses derniers messages :

```bash
sudo systemctl status astrapanel
```

```bash
sudo journalctl -u astrapanel -n 50
```

Vérifiez aussi l'adresse (`hostname -I` sur le Pi donne son IP) et, si vous avez activé `ufw`, la règle du port 8080.

**Mon site affiche « 502 Bad Gateway ».** L'application est arrêtée, plantée, ou n'écoute pas sur le bon port.
Regardez la console : votre code doit utiliser `process.env.PORT`.

**`Error: listen EADDRINUSE`.** Le port est déjà utilisé par un autre programme : changez-le dans l'onglet
**Paramètres** de l'application, puis redémarrez-la.

**`npm install` échoue.** Lisez le message d'erreur dans la console. Une erreur `node-gyp` signifie qu'un module doit
être compilé : l'installateur a déjà ajouté les outils nécessaires, mais certains modules demandent des
bibliothèques supplémentaires (le nom est indiqué dans l'erreur, à installer avec `sudo apt install`).

**Le bot affiche « Token invalide ».** Régénérez le token dans le portail développeur Discord (onglet Bot →
Reset Token) et mettez-le à jour dans l'onglet **Variables**, puis **Enregistrer et redémarrer**.

**Le bot affiche « Used disallowed intents ».** Votre code demande un *intent* privilégié (contenu des messages,
membres, présences) : activez-le dans l'onglet **Bot** du portail développeur.

**Les commandes slash n'apparaissent pas.** Vérifiez que le bot a été invité avec le scope
`applications.commands`, puis redémarrez Discord.

**« Trop de plantages d'affilée ».** Après 10 plantages rapprochés, le panel arrête de relancer l'application pour ne
pas surcharger le Pi. Corrigez l'erreur visible dans la console puis cliquez sur **Démarrer**.

**Le certificat HTTPS n'est pas obtenu.** Vérifiez que le domaine pointe bien vers votre IP publique et que les
ports 80 et 443 sont redirigés vers le Pi. Les messages de Caddy sont visibles avec :

```bash
sudo journalctl -u caddy -n 50
```

**« Sous-tension détectée » ou Pi qui redémarre tout seul.** Utilisez l'alimentation officielle 27 W et un câble
USB-C de qualité.

**Où sont les fichiers ?**

| Chemin | Contenu |
| --- | --- |
| `/opt/astrapanel` | Code du panel (mis à jour par `install.sh`) |
| `/opt/astrapanel/data/apps/<id>/` | Fichiers de chaque application |
| `/opt/astrapanel/data/logs/` | Journaux des applications |
| `/opt/astrapanel/data/db.json` | Configuration des applications, comptes, paramètres |
| `/etc/caddy/astrapanel/sites.caddy` | Configuration Caddy générée par le panel |
| `/etc/systemd/system/astrapanel.service` | Service systemd du panel |
