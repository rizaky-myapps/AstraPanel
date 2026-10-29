#!/usr/bin/env node
// Outils en ligne de commande d'AstraPanel.
// Sur le Pi, passez par le raccourci installé : sudo astrapanel-cli <commande>
import { createInterface } from 'node:readline/promises';
import { config } from './config.js';
import { Store } from './store.js';
import { Auth, hashPassword, validatePassword } from './auth.js';

const [command, ...args] = process.argv.slice(2);

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function main() {
  const store = new Store(config.dbFile);
  const auth = new Auth(store, config.dataDir);

  switch (command) {
    case 'users':
      if (!store.data.users.length) console.log('Aucun utilisateur.');
      for (const user of store.data.users) {
        console.log(`${user.username}\t(créé le ${new Date(user.createdAt).toLocaleString('fr-FR')})`);
      }
      break;

    case 'reset-password': {
      const user = auth.findUser(args[0] || '');
      if (!user) {
        const names = store.data.users.map((u) => u.username).join(', ') || 'aucun';
        throw new Error(`Utilisateur introuvable. Comptes existants : ${names}`);
      }
      const password = args[1] || (await ask(`Nouveau mot de passe pour ${user.username} : `));
      validatePassword(password);
      user.hash = await hashPassword(password);
      user.tokenVersion += 1;
      store.save();
      console.log(`Mot de passe de ${user.username} modifié.`);
      break;
    }

    case 'setup-token': {
      const token = auth.ensureSetupToken();
      console.log(token ? `Jeton d'installation : ${token}` : 'Le panel est déjà configuré (un compte existe).');
      break;
    }

    default:
      console.log(`Usage :
  astrapanel-cli users                         Liste les comptes
  astrapanel-cli reset-password <utilisateur>  Réinitialise un mot de passe
  astrapanel-cli setup-token                   Affiche le jeton de première connexion`);
  }
}

main().catch((err) => {
  console.error(`Erreur : ${err.message}`);
  process.exit(1);
});
