# Tutoriel : héberger vos sites et bots Discord sur un Raspberry Pi 5 avec AstraPanel

Ce guide part de zéro : vous préparez la carte SD, installez AstraPanel, lancez votre premier bot Discord et votre
premier site, puis mettez le tout en ligne avec votre nom de domaine en HTTPS. Comptez environ une heure.

## Sommaire

1. [Ce dont vous avez besoin](#1-ce-dont-vous-avez-besoin)
2. [Installer Raspberry Pi OS](#2-installer-raspberry-pi-os)
3. [Se connecter au Pi en SSH](#3-se-connecter-au-pi-en-ssh)
4. [Donner une adresse IP fixe au Pi](#4-donner-une-adresse-ip-fixe-au-pi)
5. [Installer AstraPanel](#5-installer-astrapanel)
6. [Première connexion et tableau de bord](#6-première-connexion-et-tableau-de-bord)
7. [Héberger un bot Discord](#7-héberger-un-bot-discord)
8. [Héberger un site web](#8-héberger-un-site-web)
9. [Gérer les fichiers d'une application](#9-gérer-les-fichiers-dune-application)
10. [Mettre vos sites en ligne sur Internet](#10-mettre-vos-sites-en-ligne-sur-internet)
11. [Déploiement automatique depuis GitHub](#11-déploiement-automatique-depuis-github)
12. [Utilisateurs et grades](#12-utilisateurs-et-grades)
13. [Sécuriser le Raspberry Pi](#13-sécuriser-le-raspberry-pi)
14. [Entretien : mises à jour, sauvegardes, journaux](#14-entretien--mises-à-jour-sauvegardes-journaux)
15. [Dépannage](#15-dépannage)

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

Pour la mise en ligne (étape 10), il vous faudra aussi un **nom de domaine** (une dizaine d'euros par an chez
OVHcloud, Gandi, Infomaniak, Cloudflare…). Les sous-domaines gratuits de type DuckDNS ne conviennent pas.

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

Votre box doit toujours attribuer la même adresse au Pi : vous retrouverez ainsi toujours le panel et vos sites à la
même adresse sur votre réseau local, et la connexion SSH ne changera pas.

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

La dernière version d'AstraPanel se trouve toujours sur la branche `AstraPanel-Latest` (chaque version est aussi gardée
sur sa propre branche `AstraPanel-V.X.Y.Z`). Téléchargez-la :

```bash
git clone -b AstraPanel-Latest https://github.com/rizaky-myapps/AstraPanel.git
```

```bash
cd AstraPanel
```

```bash
sudo ./install.sh
```

> **Dépôt privé ?** Si le dépôt GitHub est privé, `git clone` demandera un identifiant : utilisez votre nom
> d'utilisateur GitHub et, comme mot de passe, un *personal access token* (GitHub → Settings → Developer settings
> → Personal access tokens).

Le script, qui prend quelques minutes :

- installe git, zip/unzip et les outils de compilation (nécessaires à certains modules npm de bots, comme ceux pour la voix) ;
- installe **Node.js 24 LTS** si aucune version récente n'est présente ;
- crée l'utilisateur système `astrapanel`, qui fera tourner le panel et vos applications sans droits administrateur ;
- copie le panel dans `/opt/astrapanel` et crée le service `astrapanel` qui démarre avec le Pi ;
- installe le petit service `astrapanel-update`, qui permettra de **mettre le panel à jour depuis son interface**
  (plus besoin de SSH, voir l'étape 14).

À la fin, le script affiche l'adresse du panel et un **jeton d'installation** :

```
✔ AstraPanel est installé et démarré !

  Adresse du panel : http://192.168.1.50:8080
                     http://astrapanel.local:8080

  Jeton d'installation (à saisir à la première connexion) : Xy3k9QpL2mWa
```

> Option du script : `--port=9000` change le port du panel (8080 par défaut).
> Vous pouvez relancer le script à tout moment : vos applications sont conservées.

## 6. Première connexion et tableau de bord

1. Sur votre ordinateur (ou votre téléphone, connecté au même réseau), ouvrez **http://astrapanel.local:8080**.
2. Saisissez le **jeton d'installation**. Si vous l'avez perdu, affichez-le sur le Pi :

   ```bash
   sudo cat /opt/astrapanel/data/setup-token
   ```

3. Choisissez votre nom d'utilisateur et un mot de passe solide (8 caractères minimum). Ce premier compte est
   **administrateur** (voir l'étape 12 pour ajouter d'autres personnes).

Vous arrivez sur le **tableau de bord** :

- en haut, l'état actuel du Pi : processeur, température (et vitesse du ventilateur), mémoire, stockage, durée de
  fonctionnement. Si le panel affiche « Sous-tension détectée », changez d'alimentation (voir l'étape 1) ;
- en dessous, les **graphiques** du processeur, de la température et de la mémoire, avec le choix de la période :
  **1 h, 24 h, 15 j ou 30 j**. Survolez une courbe pour lire la valeur à un instant donné ; « Voir les données »
  affiche les mesures sous forme de tableau. L'historique se remplit au fil du temps (il est conservé 30 jours) ;
- un clic sur la carte **Stockage** ouvre l'explorateur de stockage : la liste des disques du Pi (carte SD, SSD,
  clé USB…) et, pour chacun, les dossiers et fichiers **triés du plus lourd au plus léger**. Cliquez sur un dossier
  pour descendre dedans et trouver ce qui prend de la place (les `node_modules`, les journaux, une vieille archive…).

Vos applications sont listées dans la barre latérale, avec le bouton **Nouvelle application**.

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

Dans l'onglet **Paramètres** de chaque application, deux interrupteurs règlent son lancement :

- **Redémarrage automatique en cas de plantage** : relance l'application si elle s'arrête de façon inattendue ;
- **Démarrer avec le Raspberry Pi** : lance l'application à chaque démarrage du Pi. Sur **OFF**, elle reste arrêtée
  jusqu'à ce que vous cliquiez sur **Démarrer** (un simple redémarrage du panel, lors d'une mise à jour par exemple,
  remet toujours chaque application dans l'état où elle était).

Pour modifier le bot, ouvrez l'onglet **Fichiers**, cliquez sur `index.js`, éditez puis **Enregistrer** (ou Ctrl+S),
et cliquez sur **Redémarrer** (voir l'étape 9 pour tout ce que permet le gestionnaire de fichiers).

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

## 9. Gérer les fichiers d'une application

L'onglet **Fichiers** de chaque application est un gestionnaire de fichiers complet :

- **Naviguer** : cliquez sur un dossier (ou sur le fil d'Ariane en haut) ; le champ « Filtrer » cherche dans le
  dossier affiché ; cliquez sur un titre de colonne pour trier par nom, taille ou date.
- **Sélectionner** : un clic sur une ligne la sélectionne, le rond à gauche ajoute ou retire un élément, Maj+clic
  sélectionne une plage, Ctrl+A tout le dossier.
- **Créer** : « Nouveau fichier », « Nouveau dossier ».
- **Téléverser** : bouton « Téléverser » (plusieurs fichiers), « Envoyer un dossier », ou glisser-déposer des
  fichiers et des dossiers directement dans la liste.
- **Avec une sélection** : renommer (F2), **déplacer**, **copier**, **compresser en ZIP**, **extraire** une archive
  (.zip, .tar.gz…), **télécharger** (un dossier ou plusieurs éléments sont téléchargés dans un ZIP) et supprimer
  (touche Suppr).
- **Ouvrir un fichier** : les fichiers texte et le code s'ouvrent dans l'**éditeur** (numéros de ligne, Ctrl+S pour
  enregistrer, retour à la ligne activable) ; les **images, vidéos et sons** s'ouvrent dans une visionneuse plein
  écran (flèches ← → pour passer au suivant, Échap pour fermer) ; les PDF s'ouvrent dans un nouvel onglet.

## 10. Mettre vos sites en ligne sur Internet

AstraPanel publie vos sites sur Internet grâce au **tunnel Cloudflare** intégré : le Raspberry Pi ouvre lui-même une
connexion sortante vers Cloudflare, qui lui transmet les visites. **Aucun port à ouvrir sur votre box**, votre adresse
IP reste privée, ça marche même sans IPv4 publique, et le HTTPS est automatique. Il vous faut seulement un nom de
domaine géré par Cloudflare (offre gratuite).

👉 **Toutes les étapes, en détail, sont dans le [tutoriel Cloudflare](CLOUDFLARE.md)** : création du compte, ajout du
domaine et changement des serveurs DNS, jeton d'API, création du tunnel, mise en ligne d'un site, vérifications et
dépannage. Ce tutoriel est aussi lisible directement dans le panel, menu **Aide** → **Tunnel Cloudflare**, et
l'onglet **Paramètres → Tunnel Cloudflare** affiche un pas-à-pas en français pour chaque étape.

En résumé, avec le mode recommandé (« Géré depuis le panel ») :

1. ajoutez votre domaine à Cloudflare et attendez qu'il soit **Active** ;
2. créez un jeton d'API avec les permissions **Account · Cloudflare Tunnel · Edit**, **Zone · DNS · Edit** et
   **Zone · Zone · Read** ;
3. dans **Paramètres → Tunnel Cloudflare** : **Installer cloudflared**, collez le jeton, **Connecter**, puis
   **Créer le tunnel** ;
4. dans les **Paramètres** d'une application, indiquez son domaine (`monsite.fr`) et enregistrez : le site est en ligne
   en HTTPS en moins d'une minute.

Le tunnel démarre automatiquement en même temps que le panel, à chaque démarrage du Raspberry Pi.

## 11. Déploiement automatique depuis GitHub

Pour qu'un `git push` mette automatiquement le site ou le bot à jour :

1. L'application doit avoir un **dépôt Git** configuré (onglet **Déploiement**).
2. Le panel doit être joignable depuis Internet (domaine du panel via le tunnel Cloudflare, voir l'étape 10).
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

## 12. Utilisateurs et grades

AstraPanel a deux grades :

| | Administrateur | Utilisateur |
| --- | :---: | :---: |
| Voir le tableau de bord et les graphiques | ✔ | ✔ |
| Créer une application, la démarrer / l'arrêter, console, fichiers, variables, déploiement | ✔ | ✔ |
| Supprimer une application | ✔ | |
| Explorateur de stockage | ✔ | |
| Paramètres : utilisateurs, mises à jour, tunnel Cloudflare, ports | ✔ | |
| Changer son propre mot de passe | ✔ | ✔ |

Les administrateurs gèrent les comptes dans **Paramètres → Utilisateurs** : **Ajouter un utilisateur** (avec son
grade), changer le grade d'un compte avec la liste déroulante, définir un nouveau mot de passe (icône clé) ou
supprimer un compte. Il reste toujours au moins un administrateur.

> Les utilisateurs peuvent modifier le code des applications : ils peuvent donc exécuter du code sur le Pi. Ne donnez
> un compte qu'à des personnes de confiance.

## 13. Sécuriser le Raspberry Pi

- **Panel** : mots de passe solides, et **jamais de redirection du port 8080** sur la box. Pour administrer à
  distance : domaine du panel en HTTPS via le tunnel Cloudflare, ou un VPN comme Tailscale ou WireGuard.
- **Code hébergé** : toutes les applications tournent sous le même utilisateur `astrapanel`. Une application peut donc
  lire les fichiers des autres, y compris leurs tokens. N'hébergez que du code en lequel vous avez confiance.
- **Pare-feu** : `ufw` n'autorise que le nécessaire. Le tunnel Cloudflare n'a besoin d'aucun port ouvert. Adaptez
  `192.168.1.0/24` à votre réseau local :

  ```bash
  sudo apt install -y ufw
  ```

  ```bash
  sudo ufw allow OpenSSH
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

## 14. Entretien : mises à jour, sauvegardes, journaux

**Mettre à jour AstraPanel depuis le panel.** Toutes les **5 minutes**, le panel regarde la branche
`AstraPanel-Latest` sur GitHub et lit la version écrite dans son `package.json`. Si elle est plus récente que la
version installée, les administrateurs voient un **bandeau vert** en haut de chaque page : « Mise à jour disponible ».
Dans **Paramètres → Mises à jour** :

- vous voyez la **version installée**, la **dernière version publiée** et l'heure de la prochaine vérification ;
- **Vérifier maintenant** : vérifie tout de suite, sans attendre les 5 minutes ;
- **Mettre à jour vers la X.Y.Z** : télécharge la nouvelle version et l'installe. Le journal s'affiche en direct ; le
  panel redémarre (vos applications aussi) et la page se recharge toute seule au bout d'une à trois minutes.

> Si votre panel a été installé avant l'arrivée de cette fonction, faites une dernière mise à jour en SSH en
> réinstallant depuis la dernière version (étape 5, dans un nouveau dossier) : les suivantes se feront depuis le panel.

En SSH, la même mise à jour se lance avec :

```bash
sudo astrapanel-update
```

Pour revenir à une version précise (chaque version a sa branche `AstraPanel-V.X.Y.Z`), par exemple la 1.2.3 :

```bash
sudo astrapanel-update AstraPanel-V.1.2.3
```

Le panel proposera de nouveau la dernière version dans les 5 minutes. Ne revenez pas avant la 1.2.3 : les versions
plus anciennes ne savent pas suivre la branche `AstraPanel-Latest`.

**Journaux du panel** :

```bash
sudo journalctl -u astrapanel -f
```

Les journaux de chaque application sont dans la console du panel (bouton **Télécharger** pour le fichier complet) et
dans `/opt/astrapanel/data/logs/`. Le journal de la dernière mise à jour est dans `/var/log/astrapanel-update.log`.

**Sauvegarder** applications, configuration, comptes et historique :

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

## 15. Dépannage

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

**Tunnel Cloudflare : « Cloudflare : … » lors de la connexion.** Le jeton d'API n'a pas les bonnes permissions
(revoyez l'[étape 5.1 du tutoriel Cloudflare](CLOUDFLARE.md#51-créer-un-jeton-dapi-cloudflare)) ou a expiré. Si le tunnel reste sur « Connexion… », lisez son journal en bas de la page
**Paramètres → Tunnel Cloudflare**.

**Tunnel Cloudflare : « Conflit DNS ».** Un enregistrement existe déjà pour ce domaine chez Cloudflare. Cliquez sur
**Remplacer** (ou supprimez-le vous-même dans le tableau de bord Cloudflare puis **Synchroniser**).

**« La branche AstraPanel-version… n'existe pas sur le dépôt ».** Votre panel est antérieur à la version 1.2.3 et
cherche encore les anciennes branches. Réinstallez-le une fois en SSH depuis `AstraPanel-Latest` (vos applications et
comptes sont conservés) :

```bash
rm -rf ~/AstraPanel && git clone -b AstraPanel-Latest https://github.com/rizaky-myapps/AstraPanel.git ~/AstraPanel
```

```bash
cd ~/AstraPanel && sudo ./install.sh
```

Les mises à jour suivantes se feront depuis le panel.

**La mise à jour depuis le panel échoue.** Le journal de la mise à jour s'affiche dans **Paramètres → Mises à jour**.
Si le dépôt GitHub est privé, il doit avoir été cloné avec un jeton dans l'URL pour que le Pi puisse le télécharger.
Les messages du service sont aussi visibles avec :

```bash
sudo journalctl -u astrapanel-update -n 50
```

**Le site ne s'ouvre pas depuis Internet.** Consultez la partie dépannage du [tutoriel Cloudflare](CLOUDFLARE.md#9-dépannage).

**« Sous-tension détectée » ou Pi qui redémarre tout seul.** Utilisez l'alimentation officielle 27 W et un câble
USB-C de qualité.

**Où sont les fichiers ?**

| Chemin | Contenu |
| --- | --- |
| `/opt/astrapanel` | Code du panel (mis à jour par `install.sh` ou depuis le panel) |
| `/opt/astrapanel/data/apps/<id>/` | Fichiers de chaque application |
| `/opt/astrapanel/data/logs/` | Journaux des applications et du tunnel |
| `/opt/astrapanel/data/db.json` | Configuration des applications, comptes, paramètres |
| `/opt/astrapanel/data/metrics.json` | Historique des graphiques (15 et 30 jours) |
| `/opt/astrapanel/data/bin/cloudflared` | Programme du tunnel Cloudflare, téléchargé par le panel |
| `/var/lib/astrapanel/source` | Copie du dépôt GitHub utilisée par les mises à jour |
| `/etc/systemd/system/astrapanel.service` | Service systemd du panel |
| `/etc/systemd/system/astrapanel-update.*` | Service de mise à jour (lancé quand le panel le demande) |
