# Tutoriel : mettre vos sites en ligne avec le tunnel Cloudflare

Ce guide explique, étape par étape, comment rendre les sites hébergés sur votre Raspberry Pi accessibles depuis
Internet, en **HTTPS**, avec **votre nom de domaine**, grâce au tunnel Cloudflare intégré à AstraPanel.

**Pourquoi un tunnel ?** Le Raspberry Pi ouvre lui-même une connexion sortante vers Cloudflare, qui lui transmet
ensuite les visites. Résultat :

- aucun port à ouvrir sur votre box, et votre adresse IP personnelle n'est jamais exposée ;
- ça fonctionne même si votre fournisseur d'accès ne vous donne pas d'IPv4 publique ;
- le certificat HTTPS est fourni et renouvelé automatiquement par Cloudflare ;
- c'est gratuit (offre *Free* de Cloudflare).

> Ce tutoriel est aussi disponible dans le panel : menu **Aide** → **Tunnel Cloudflare**. L'onglet
> **Paramètres → Tunnel Cloudflare** reprend ces étapes, en français, à côté des boutons à utiliser.

> Les menus du tableau de bord Cloudflare sont indiqués **en anglais, tels qu'ils apparaissent à l'écran**, avec la
> traduction entre parenthèses quand c'est utile. Cloudflare fait évoluer son interface : si un libellé diffère
> légèrement, cherchez le terme le plus proche.

## Sommaire

1. [Ce qu'il vous faut](#1-ce-quil-vous-faut)
2. [Créer un compte Cloudflare](#2-créer-un-compte-cloudflare)
3. [Ajouter votre nom de domaine à Cloudflare](#3-ajouter-votre-nom-de-domaine-à-cloudflare)
4. [Choisir le mode de gestion du tunnel](#4-choisir-le-mode-de-gestion-du-tunnel)
5. [Mode A : tunnel géré depuis le panel (recommandé)](#5-mode-a--tunnel-géré-depuis-le-panel-recommandé)
6. [Mode B : tunnel géré depuis le site Cloudflare](#6-mode-b--tunnel-géré-depuis-le-site-cloudflare)
7. [Accéder au panel depuis Internet](#7-accéder-au-panel-depuis-internet)
8. [Vérifier que tout fonctionne](#8-vérifier-que-tout-fonctionne)
9. [Dépannage](#9-dépannage)
10. [Arrêter ou supprimer le tunnel](#10-arrêter-ou-supprimer-le-tunnel)

---

## 1. Ce qu'il vous faut

- AstraPanel installé et accessible sur votre réseau local (`http://astrapanel.local:8080`), avec un compte
  **administrateur** ;
- au moins un site qui fonctionne en local (par exemple `http://astrapanel.local:4000`) ;
- un **nom de domaine** à vous (par exemple `monsite.fr`), acheté chez un registrar : OVHcloud, Gandi, Infomaniak,
  IONOS… ou directement chez Cloudflare (voir l'étape 3). Comptez environ 10 € par an.

> Les sous-domaines gratuits (DuckDNS, No-IP…) **ne fonctionnent pas** avec le tunnel : Cloudflare doit gérer tout le
> domaine.

## 2. Créer un compte Cloudflare

1. Allez sur [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Saisissez votre adresse e-mail et un mot de passe, puis validez.
3. Confirmez votre adresse en cliquant sur le lien reçu par e-mail.

L'offre gratuite suffit pour tout ce tutoriel : aucune carte bancaire n'est demandée pour le tunnel.

## 3. Ajouter votre nom de domaine à Cloudflare

> **Vous n'avez pas encore de domaine ?** Vous pouvez l'acheter directement chez Cloudflare (menu
> **Domain Registration** → **Register Domains**). Il sera automatiquement géré par Cloudflare : passez directement à
> l'étape 4.

Si votre domaine a été acheté ailleurs, il faut confier sa gestion DNS à Cloudflare. **Vous restez propriétaire du
domaine chez votre registrar** ; vous changez seulement ses « serveurs de noms ».

### 3.1 Ajouter le domaine dans Cloudflare

1. Connectez-vous au [tableau de bord Cloudflare](https://dash.cloudflare.com).
2. Cliquez sur **Onboard a domain** (ajouter un domaine).
3. Saisissez votre domaine **sans `www`** (par exemple `monsite.fr`), laissez Cloudflare rechercher automatiquement
   les enregistrements DNS existants, puis cliquez sur **Continue**.
4. Choisissez l'offre **Free** (gratuite) en bas de la liste des offres, puis continuez.
5. Cloudflare affiche la liste des enregistrements DNS trouvés : continuez.
6. Cloudflare vous donne **deux serveurs de noms** (*nameservers*), du type `ada.ns.cloudflare.com` et
   `bob.ns.cloudflare.com`. **Notez-les exactement** (ils sont différents pour chaque compte). Gardez cette page ouverte.

### 3.2 Changer les serveurs de noms chez votre registrar

> **Avant de commencer** : si **DNSSEC** est activé chez votre registrar, désactivez-le d'abord. Vous pourrez le
> réactiver plus tard depuis Cloudflare.

**Chez OVHcloud :**

1. Connectez-vous à l'[espace client OVHcloud](https://www.ovh.com/manager/).
2. Ouvrez **Web Cloud** → **Noms de domaine** → votre domaine.
3. Onglet **Serveurs DNS** → **Modifier les serveurs DNS**.
4. Remplacez les serveurs existants par les deux serveurs Cloudflare (supprimez les autres lignes), puis validez.

**Chez un autre registrar** (Gandi, Infomaniak, IONOS…) : cherchez la rubrique **Serveurs de noms**, **Nameservers**
ou **Serveurs DNS** de votre domaine, choisissez des serveurs « externes » ou « personnalisés », et indiquez
**uniquement** les deux serveurs Cloudflare, en les recopiant exactement.

### 3.3 Attendre l'activation

1. Revenez sur la page Cloudflare et cliquez sur le bouton de vérification des serveurs de noms
   (*Check nameservers*).
2. Le changement prend en général de quelques minutes à quelques heures, **jusqu'à 24 heures**. Pendant ce temps, le
   domaine est marqué *Pending Nameserver Update* (en attente).
3. Quand c'est terminé, Cloudflare vous envoie un e-mail et le domaine apparaît **Active** dans la liste **Domains**.

**Ne passez à la suite qu'une fois le domaine « Active ».**

## 4. Choisir le mode de gestion du tunnel

Dans AstraPanel, ouvrez **Paramètres** → **Tunnel Cloudflare**. Deux modes sont proposés :

| | **A. Géré depuis le panel** (recommandé) | **B. Géré depuis le site Cloudflare** |
| --- | --- | --- |
| Création du tunnel | automatique | à la main sur le site Cloudflare |
| Enregistrements DNS | créés et supprimés automatiquement | créés par Cloudflare quand vous ajoutez une route |
| Ajouter un site en ligne | ajouter le domaine dans l'application, c'est tout | ajouter aussi une route sur le site Cloudflare |
| Ce qu'il faut fournir au panel | un jeton d'API Cloudflare | le jeton du tunnel |

Dans les deux cas, commencez par cliquer sur **Installer cloudflared** dans la carte **État** : le panel télécharge
le programme officiel de Cloudflare pour le Raspberry Pi. Aucune commande à taper en SSH.

Ensuite, le panel vérifie lui-même sur GitHub (au démarrage puis toutes les 12 heures) s'il existe une version plus
récente de cloudflared. Le bouton de la carte **État** affiche alors **Mettre à jour vers la X** ; sinon, il affiche
**Vérifier les mises à jour** pour lancer une vérification tout de suite.

## 5. Mode A : tunnel géré depuis le panel (recommandé)

### 5.1 Créer un jeton d'API Cloudflare

Le jeton d'API permet au panel de créer le tunnel et les enregistrements DNS à votre place, **uniquement** avec les
droits que vous lui donnez. Les libellés ci-dessous sont ceux du tableau de bord **en français** (l'équivalent anglais
est indiqué entre parenthèses).

1. Ouvrez [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   (menu **Paramètres utilisateur** → **Identifiants API** → **Jetons API**), puis cliquez sur **Créer un jeton**
   (*Create Token*).
2. **Nom du jeton** : écrivez par exemple `AstraPanel`.
3. **Politiques** : cliquez sur **Commencer de zéro** (la ligne marquée *Custom*). Une politique **Zone** s'ouvre :
   - laissez **Inclure** et **Toutes les zones** ;
   - dépliez la catégorie **DNS & Zones** et cochez **DNS** avec le niveau **Modifier** (*Edit*), puis **Zone** avec le
     niveau **Lire** (*Read*).
4. Cliquez sur **Ajouter une nouvelle politique** et choisissez le type **Compte** :
   - laissez **Inclure** et choisissez votre compte ;
   - dans **Rechercher des groupes d'autorisations…**, tapez `Tunnel` et cochez **Cloudflare Tunnel** avec le niveau
     **Modifier**.
5. Vérifiez le récapitulatif des politiques :

   | Politique | Portée | Permissions affichées |
   | --- | --- | --- |
   | **Politique Zone** | Inclure toutes les zones | DNS Write, Zone Read |
   | **Politique Compte** | Inclure votre compte | Cloudflare Tunnel Write |

6. **Expiration du jeton** : choisissez **Pas d'expiration**. Avec une durée limitée, le tunnel continue de tourner à
   l'échéance, mais le panel ne peut plus publier ni retirer de domaines (il faut alors créer un nouveau jeton).
7. **Filtrage des adresses IP client** : laissez vide (l'adresse IP de votre box peut changer).
8. Cliquez sur **Continuer vers le résumé** (*Continue to summary*), vérifiez, puis validez la création du jeton.
9. **Copiez le jeton affiché** : Cloudflare ne le montrera qu'une seule fois. Ne le partagez avec personne.

### 5.2 Connecter le panel à Cloudflare

1. Dans AstraPanel → **Paramètres** → **Tunnel Cloudflare**, choisissez **Géré depuis le panel**.
2. Étape **1. Jeton d'API Cloudflare** : collez le jeton, puis cliquez sur **Connecter**.
   Le panel vérifie le jeton et affiche « Jeton d'API vérifié ».
3. Étape **2. Tunnel** : choisissez votre compte Cloudflare dans la liste, gardez le nom proposé
   (`astrapanel-…`) ou changez-le, puis cliquez sur **Créer le tunnel**.
4. En quelques secondes, l'état en haut de la page passe à **Connecté · 4 liaison(s)**. L'interrupteur
   **Tunnel actif** est sur **ON** : le tunnel redémarrera tout seul avec le Raspberry Pi.

### 5.3 Mettre un site en ligne

1. Ouvrez l'application (le site) dans AstraPanel → onglet **Paramètres**.
2. Dans **Nom(s) de domaine**, écrivez l'adresse voulue, par exemple `monsite.fr` ou `blog.monsite.fr`.
   Plusieurs adresses sont possibles, séparées par des virgules : `monsite.fr, www.monsite.fr`.
3. Cliquez sur **Enregistrer**.

Le panel ajoute la route dans le tunnel et crée l'enregistrement DNS (un `CNAME` vers le tunnel, avec le commentaire
« Géré par AstraPanel »). Dans **Paramètres** → **Tunnel Cloudflare**, le tableau **Domaines publiés** affiche
**En ligne** pour ce domaine. Le site répond en HTTPS en général en moins d'une minute.

Pour retirer un site d'Internet, effacez son domaine dans les paramètres de l'application et enregistrez : la route et
l'enregistrement DNS sont supprimés.

### 5.4 Comprendre l'état des domaines

| État | Signification | Que faire |
| --- | --- | --- |
| **En ligne** | la route et le DNS sont en place | rien |
| **Conflit DNS** | un enregistrement existe déjà pour ce nom chez Cloudflare (par exemple un ancien enregistrement `A`) | cliquez sur **Remplacer** pour le remplacer par celui du tunnel |
| **Domaine inconnu** | ce domaine n'est pas dans votre compte Cloudflare, ou pas encore « Active » | ajoutez-le (étape 3) ou corrigez la faute de frappe |
| **Erreur** | Cloudflare a refusé l'opération | lisez le message, vérifiez les permissions du jeton (étape 5.1), puis **Synchroniser** |

## 6. Mode B : tunnel géré depuis le site Cloudflare

Dans ce mode, vous créez le tunnel et ses routes vous-même sur le site de Cloudflare ; le panel se contente de faire
tourner le tunnel sur le Raspberry Pi.

### 6.1 Créer le tunnel sur Cloudflare

1. Dans le [tableau de bord Cloudflare](https://dash.cloudflare.com), ouvrez **Networking** → **Tunnels**.
2. Cliquez sur **Create a tunnel**.
3. Donnez-lui un nom (par exemple `raspberry-pi`), puis cliquez sur **Create Tunnel**.
4. Cloudflare propose d'installer le connecteur : choisissez le système **Debian** (Linux). Une commande s'affiche, du
   type :

   ```
   sudo cloudflared service install eyJhIjoiNjc4…
   ```

   **Ne la lancez pas sur le Raspberry Pi** : copiez-la entièrement.

### 6.2 Donner le jeton au panel

1. Dans AstraPanel → **Paramètres** → **Tunnel Cloudflare**, choisissez **Géré depuis le site Cloudflare**.
2. Collez la commande copiée (ou seulement le jeton, la longue suite de caractères qui commence par `eyJ`).
3. Cliquez sur **Enregistrer et démarrer**. L'état passe à **Connecté**.
4. Retournez sur la page Cloudflare : le connecteur apparaît comme connecté. Cliquez sur **Continue**.

### 6.3 Publier un site

1. Sur Cloudflare, **Networking** → **Tunnels** → cliquez sur votre tunnel.
2. Onglet **Routes** → **Add route** → **Published application**.
3. Remplissez :
   - **Subdomain** : la partie avant le domaine (par exemple `blog`), ou laissez vide pour le domaine seul ;
   - **Domain** : choisissez votre domaine dans la liste ;
   - **Service URL** : l'adresse locale du site, telle qu'indiquée par le panel dans le tableau « Service à indiquer
     dans Cloudflare », par exemple `http://localhost:4000`.
4. Cliquez sur **Add route**. Cloudflare crée lui-même l'enregistrement DNS.

> Sur certains comptes, l'ancienne interface est encore affichée : **Zero Trust** → **Networks** → **Tunnels**, puis
> l'onglet **Public Hostname** → **Add a public hostname**, avec les champs **Subdomain**, **Domain**, **Type**
> (choisissez **HTTP**) et **URL** (`localhost:4000`). Le principe est identique.

## 7. Accéder au panel depuis Internet

Vous pouvez aussi rendre le panel lui-même accessible, par exemple sur `https://panel.monsite.fr` :

- **Mode A** : AstraPanel → **Paramètres** → **Général** → **Domaine du panel** → `panel.monsite.fr` →
  **Enregistrer**.
- **Mode B** : ajoutez une route `panel.monsite.fr` vers `http://localhost:8080` (étape 6.3).

> Le panel permet de contrôler tout le Raspberry Pi : utilisez des mots de passe solides pour tous les comptes.
> Pour encore plus de sécurité, vous pouvez protéger cette adresse avec **Cloudflare Access** (connexion par e-mail
> avant d'arriver sur le panel), disponible dans **Zero Trust** → **Access**.

## 8. Vérifier que tout fonctionne

1. Dans AstraPanel → **Paramètres** → **Tunnel Cloudflare** : l'état indique **Connecté** et le journal du tunnel
   affiche des lignes `Registered tunnel connection`.
2. Sur Cloudflare → **Networking** → **Tunnels** : le tunnel est marqué **Healthy** (en bonne santé).
3. Depuis votre téléphone **en 4G/5G (Wi-Fi coupé)**, ouvrez `https://monsite.fr` : le site s'affiche avec le
   cadenas.
4. Redémarrez le Raspberry Pi (`sudo reboot`) : une fois le panel relancé, le tunnel se reconnecte tout seul, en
   même temps que le panel, sans aucune action de votre part.

## 9. Dépannage

**« Cloudflare : Invalid API Token » ou « Authentication error » en connectant le jeton.**
Le jeton est mal copié ou n'a pas les bonnes permissions. Recréez-le en suivant exactement l'étape 5.1.

**« Aucun compte trouvé avec ce jeton ».**
Le panel retrouve votre compte à partir de vos domaines : vérifiez que la **Politique Zone** inclut **toutes les zones**
avec **Zone Read**, et que votre domaine est bien ajouté à Cloudflare (étape 3). Avant la version 1.2.1, le panel
affichait « Ce jeton n'a accès à aucun compte » même avec un jeton correct : mettez le panel à jour.

**Le domaine reste « Pending Nameserver Update » chez Cloudflare.**
Vérifiez chez votre registrar que **seuls** les deux serveurs Cloudflare sont indiqués, recopiés sans faute, et que
DNSSEC est désactivé. Le changement peut prendre jusqu'à 24 heures.

**L'état du tunnel reste sur « Connexion… ».**
Vérifiez que le Raspberry Pi a accès à Internet, puis lisez le **journal du tunnel** en bas de la page. Après 5
minutes sans connexion, le panel relance le tunnel automatiquement ; vous pouvez aussi cliquer sur **Redémarrer**.

**Le site affiche une page d'erreur Cloudflare « Bad gateway » (502).**
Le tunnel fonctionne mais l'application ne répond pas : elle est arrêtée, plantée, ou n'écoute pas sur son port.
Regardez sa console dans AstraPanel ; un site Node.js doit utiliser `process.env.PORT`.

**Le site affiche l'erreur Cloudflare 1033.**
Le tunnel n'est pas connecté : vérifiez l'interrupteur **Tunnel actif** et le journal du tunnel.

**« Conflit DNS » sur un domaine (mode A).**
Un enregistrement existait déjà pour ce nom (souvent un ancien `A` vers votre box). Cliquez sur **Remplacer**.

**Le navigateur affiche « Ce site est inaccessible » / DNS introuvable.**
L'enregistrement DNS vient d'être créé : attendez quelques minutes. Vérifiez dans Cloudflare → votre domaine →
**DNS** → **Records** qu'un `CNAME` vers `….cfargotunnel.com` existe pour ce nom.

## 10. Arrêter ou supprimer le tunnel

- **Mettre en pause** : AstraPanel → **Paramètres** → **Tunnel Cloudflare** → interrupteur **Tunnel actif** sur
  **OFF**. Les sites ne sont plus accessibles depuis Internet (ils restent accessibles en local).
- **Supprimer la configuration du panel** : bouton **Supprimer la configuration du tunnel** en bas de la page. Les
  jetons sont effacés du panel.
- **Supprimer le tunnel chez Cloudflare** : **Networking** → **Tunnels** → menu **⋯** du tunnel → **Delete**, puis
  supprimez les enregistrements DNS correspondants dans **DNS** → **Records**.
- **Révoquer le jeton d'API** : [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  → menu **⋯** du jeton → **Delete**.
