# AstraPanel : installation

AstraPanel est un panel web, en français, pour héberger vos **bots Discord**, vos **sites web JavaScript** et vos
**serveurs Minecraft** sur votre propre machine. Ce guide explique, pas à pas, comment l'installer : choix de la machine et du système, commandes à
taper, première connexion. Comptez 20 à 30 minutes, installation du système comprise.

![Tableau de bord d'AstraPanel](docs/images/tableau-de-bord.png)

## Sommaire

1. [Choisir la machine](#1-choisir-la-machine)
2. [Choisir le système d'exploitation](#2-choisir-le-système-dexploitation)
3. [Installer le système](#3-installer-le-système)
4. [Se connecter à la machine en SSH](#4-se-connecter-à-la-machine-en-ssh)
5. [Préparer le système](#5-préparer-le-système)
6. [Installer AstraPanel](#6-installer-astrapanel)
7. [Première connexion](#7-première-connexion)
8. [Commandes utiles](#8-commandes-utiles)
9. [Désinstaller](#9-désinstaller)
10. [En cas de problème](#10-en-cas-de-problème)
11. [Et ensuite ?](#11-et-ensuite-)

---

## 1. Choisir la machine

AstraPanel tourne sur n'importe quelle machine capable de faire tourner Linux en **64 bits** : un ancien ordinateur, un
mini-PC, un serveur à la maison, une carte ARM 64 bits, ou un serveur loué (VPS) chez un hébergeur.

| | Minimum | Conseillé |
| --- | --- | --- |
| Processeur | 64 bits : **x86-64** (Intel, AMD) ou **ARM64** | 2 cœurs ou plus |
| Mémoire vive | 2 Go (quelques bots) | 4 Go ou plus (plusieurs bots et sites), 8 Go avec un serveur Minecraft |
| Stockage | 16 Go libres | un **SSD**, plus rapide et plus fiable allumé 24 h/24 |
| Réseau | Wi-Fi | un **câble Ethernet** relié à la box |

La machine doit rester allumée en permanence : c'est elle qui fera tourner vos bots et vos sites.

Il vous faut aussi un **ordinateur** (Windows, macOS ou Linux) pour vous connecter à la machine et ouvrir le panel dans
un navigateur.

## 2. Choisir le système d'exploitation

Le script d'installation a besoin d'un **Linux 64 bits avec `apt` et `systemd`**.

| Système | |
| --- | --- |
| **Debian 12 ou 13**, version sans bureau | ✅ **Recommandé** : léger et très stable |
| **Ubuntu Server 24.04 LTS** ou plus récent | ✅ **Recommandé** : le plus simple à trouver chez les hébergeurs |
| Dérivés de Debian / Ubuntu (Linux Mint, Armbian, Pop!_OS…) | ✅ Compatible |
| Windows, macOS | ❌ Non compatible |
| Fedora, Arch, Alpine, openSUSE… (sans `apt`) | ❌ Non compatible |
| Systèmes 32 bits | ❌ Déconseillé (Node.js et de nombreux modules ne les gèrent plus) |

**Prenez une version serveur, sans environnement de bureau** : elle laisse toute la mémoire à vos applications. Vous
n'aurez jamais besoin d'écran sur la machine : tout se fait depuis votre ordinateur.

## 3. Installer le système

### Machine à la maison

1. **Téléchargez** l'image d'installation :
   - Debian : [debian.org/download](https://www.debian.org/download) (image « netinst » pour PC 64 bits) ;
   - ou Ubuntu Server : [ubuntu.com/download/server](https://ubuntu.com/download/server).

   Pour une carte ARM, prenez l'image **64 bits** officielle de son fabricant (Debian ou Ubuntu).
2. **Créez une clé USB d'installation** (8 Go minimum, elle sera effacée) avec
   [balenaEtcher](https://etcher.balena.io/) (Windows, macOS, Linux) ou [Rufus](https://rufus.ie/) (Windows).
3. **Démarrez la machine sur la clé** : branchez-la, allumez la machine et appuyez sur la touche du menu de démarrage
   (souvent **F12**, **F11**, **F8** ou **Échap**, affichée au démarrage), puis choisissez la clé USB.
4. **Suivez l'installation** :
   - **Nom de la machine** : par exemple `astrapanel` ;
   - **Debian** : laissez le **mot de passe « root » vide** ; le compte que vous créez ensuite pourra alors utiliser
     `sudo` (indispensable pour la suite) ;
   - **Compte utilisateur** : un nom (par exemple `admin`) et un mot de passe solide ;
   - **Disque** : « utiliser un disque entier » (⚠️ tout son contenu est effacé) ;
   - **Logiciels** (Debian) : décochez **environnement de bureau** et **GNOME**, cochez **serveur SSH** et
     **utilitaires usuels du système** ;
   - **Ubuntu Server** : cochez **Install OpenSSH server**.
5. Retirez la clé quand l'installation le demande : la machine redémarre sur le système installé.

Laissez la machine branchée au réseau. Si elle a déjà un Debian ou un Ubuntu compatible, gardez-le : il suffit que le
serveur SSH soit installé (`sudo apt install -y openssh-server`).

### Serveur loué (VPS)

Chez votre hébergeur (OVHcloud, Hetzner, Scaleway, Ionos…), choisissez **Debian 12/13** ou **Ubuntu 24.04 LTS** (ou
plus récent) à la commande. Vous recevez l'**adresse IP** du serveur et un accès SSH.

> Si l'hébergeur vous connecte directement en **root**, tapez les commandes de ce guide **sans** le mot `sudo` (ou
> installez-le d'abord avec `apt install -y sudo`).

## 4. Se connecter à la machine en SSH

**Trouvez l'adresse IP de la machine** : dans l'interface de votre box (liste des appareils connectés), ou sur la
machine elle-même avec la commande `hostname -I`. Pour un VPS, l'hébergeur vous l'a donnée.

Sur votre ordinateur, ouvrez un terminal : sous Windows, **Terminal** ou **PowerShell** (la commande `ssh` est déjà
installée) ; sous macOS et Linux, l'application **Terminal**. Tapez, en remplaçant `admin` par votre nom
d'utilisateur et `192.168.1.50` par l'adresse de la machine :

```bash
ssh admin@192.168.1.50
```

À la première connexion, tapez `yes` pour accepter l'empreinte de la machine, puis votre mot de passe (rien ne
s'affiche pendant la saisie, c'est normal).

> **Conseil (machine à la maison)** : dans l'interface de votre box, rubrique **DHCP / baux statiques** (ou
> « IP fixe »), réservez cette adresse à la machine. Elle ne changera plus, et le panel restera toujours à la même
> adresse.

## 5. Préparer le système

Toutes les commandes suivantes se tapent **sur la machine**, dans la session SSH.

Vérifiez d'abord que votre compte peut utiliser `sudo` :

```bash
sudo whoami
```

La réponse doit être `root`. Si vous lisez « *n'est pas dans le fichier sudoers* » (« *is not in the sudoers file* »),
passez en root avec `su -` (mot de passe root), tapez `usermod -aG sudo admin` (avec votre nom d'utilisateur), puis
`exit` deux fois et reconnectez-vous en SSH.

Mettez le système à jour :

```bash
sudo apt update && sudo apt full-upgrade -y
```

Redémarrez la machine :

```bash
sudo reboot
```

Attendez une minute, puis reconnectez-vous en SSH (même commande qu'à l'étape 4).

## 6. Installer AstraPanel

Installez git, qui sert à télécharger le panel :

```bash
sudo apt install -y git
```

Téléchargez la dernière version d'AstraPanel (elle est toujours sur la branche `AstraPanel-Latest`) :

```bash
git clone -b AstraPanel-Latest https://github.com/rizaky-myapps/AstraPanel.git
```

Entrez dans le dossier téléchargé :

```bash
cd AstraPanel
```

Lancez l'installation :

```bash
sudo ./install.sh
```

> **Dépôt privé ?** Si `git clone` demande un identifiant, entrez votre nom d'utilisateur GitHub puis, comme mot de
> passe, un *personal access token* (GitHub → Settings → Developer settings → Personal access tokens).

Le script travaille seul pendant quelques minutes. Il :

- installe les outils nécessaires : git, zip / unzip, rsync et les outils de compilation (utiles à certains modules
  npm de vos bots, comme ceux pour la voix) ;
- installe **Node.js 24 LTS** si la machine n'a pas déjà Node.js 20 ou plus récent ;
- crée l'utilisateur système `astrapanel`, qui fait tourner le panel et vos applications **sans droits
  administrateur** ;
- copie le panel dans `/opt/astrapanel` et crée le service `astrapanel`, qui **démarre tout seul avec la machine** ;
- installe les services de **mise à jour** et de **redémarrage** que le panel déclenche depuis son interface.

À la fin, il affiche l'adresse du panel et un **jeton d'installation** (notez-le) :

```
✔ AstraPanel est installé et démarré !

  Adresse du panel : http://192.168.1.50:8080

  Jeton d'installation (à saisir à la première connexion) : Xy3k9QpL2mWa
```

Le panel utilise le **port 8080**. Pour en choisir un autre, lancez l'installation avec l'option `--port` :

```bash
sudo ./install.sh --port=9000
```

## 7. Première connexion

1. Sur votre ordinateur (ou votre téléphone), **connecté au même réseau que la machine**, ouvrez dans le navigateur
   l'adresse affichée par le script : `http://<ip-de-la-machine>:8080`.
2. Saisissez le **jeton d'installation**. Si vous l'avez perdu, affichez-le sur la machine :

   ```bash
   sudo cat /opt/astrapanel/data/setup-token
   ```

3. Choisissez votre **nom d'utilisateur** et un **mot de passe** solide (8 caractères minimum). Ce premier compte est
   **administrateur** : il pourra ensuite créer d'autres comptes.

C'est installé ! 🎉 Vous arrivez sur le tableau de bord du panel.

> **Pare-feu** : si vous avez activé `ufw` sur la machine, autorisez le panel (le script vous le rappelle) :
>
> ```bash
> sudo ufw allow 8080/tcp
> ```
>
> N'ouvrez **jamais** le port 8080 sur votre box : pour accéder au panel depuis l'extérieur, utilisez le tunnel
> Cloudflare intégré (voir le [tutoriel Cloudflare](docs/CLOUDFLARE.md)) ou un VPN.

## 8. Commandes utiles

Toutes se tapent sur la machine, en SSH.

| Pour… | Commande |
| --- | --- |
| Voir si le panel tourne | `sudo systemctl status astrapanel` |
| Lire ses messages en direct (Ctrl+C pour quitter) | `sudo journalctl -u astrapanel -f` |
| Le redémarrer | `sudo systemctl restart astrapanel` |
| Le mettre à jour (aussi possible depuis **Paramètres → Mises à jour**, ou automatiquement) | `sudo astrapanel-update` |
| Revenir à une version précise | `sudo astrapanel-update AstraPanel-V.1.4.4` |
| Réinitialiser un mot de passe oublié | `sudo astrapanel-cli reset-password admin` |
| Retrouver l'adresse IP de la machine | `hostname -I` |

Les mises à jour sont annoncées dans le panel (cloche de la barre du haut) dès leur publication : un clic dans
**Paramètres → Mises à jour** suffit, sans SSH. L'interrupteur **Mises à jour automatiques** les installe même
toutes seules.

Pour **changer le port** plus tard, relancez l'installation depuis le dossier téléchargé, après l'avoir mis à jour
(vos applications et vos comptes sont conservés) :

```bash
cd ~/AstraPanel && git pull && sudo ./install.sh --port=9000
```

## 9. Désinstaller

Depuis le dossier téléchargé à l'étape 6 :

```bash
cd ~/AstraPanel && sudo ./uninstall.sh
```

Vos données (applications, comptes, journaux) restent dans `/opt/astrapanel/data`. Pour **tout supprimer**,
définitivement :

```bash
cd ~/AstraPanel && sudo ./uninstall.sh --purge
```

## 10. En cas de problème

**La page du panel ne s'ouvre pas.**
- Vérifiez que le panel tourne : `sudo systemctl status astrapanel` doit afficher `active (running)`. Sinon, lisez
  ses derniers messages : `sudo journalctl -u astrapanel -n 50`.
- Vérifiez l'adresse : `hostname -I` donne l'IP de la machine, et le port est `8080` (sauf si vous l'avez changé).
- Votre ordinateur doit être sur le même réseau que la machine (pas en 4G, par exemple).
- Pare-feu `ufw` actif : `sudo ufw allow 8080/tcp`.

**« Lancez ce script avec sudo ».** Tapez bien `sudo ./install.sh`, depuis le dossier `AstraPanel`.

**« sudo : commande introuvable ».** Le système n'a pas `sudo` (installation Debian avec un mot de passe root,
certains VPS) : passez en root avec `su -`, puis `apt install -y sudo` et `usermod -aG sudo admin` (avec votre nom
d'utilisateur), puis déconnectez-vous et reconnectez-vous.

**« Système 32 bits détecté ».** Réinstallez la machine avec un système **64 bits** (étape 3).

**L'installation s'arrête sur une erreur réseau** (téléchargement de Node.js ou des paquets). Vérifiez la connexion
de la machine (`ping -c 3 debian.org`) puis relancez simplement `sudo ./install.sh` : le script peut être relancé
autant de fois que nécessaire, sans rien perdre.

**Mot de passe du panel oublié.** `sudo astrapanel-cli reset-password admin` (avec votre nom d'utilisateur du panel).

## 11. Et ensuite ?

- 📘 [**Tutoriel complet**](docs/TUTORIEL.md) : prise en main du panel, héberger un bot Discord, un site Node.js ou
  statique, un serveur Minecraft, gérer les fichiers, le déploiement automatique depuis GitHub, les utilisateurs, la sécurité de la
  machine, les sauvegardes.
- ☁️ [**Tutoriel Cloudflare**](docs/CLOUDFLARE.md) : mettre vos sites en ligne en HTTPS avec votre nom de domaine,
  sans ouvrir de port sur votre box.
- 🛠️ [**Fonctionnement technique**](docs/TECHNIQUE.md) : architecture, versions, développement et sécurité.
