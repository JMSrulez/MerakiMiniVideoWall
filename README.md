# Meraki Video Wall

Videowall web pour cameras Cisco Meraki MV : liste a gauche, quatre emplacements,
filtre par reseau, recherche, plein ecran, reconnexion et disposition memorisee.
Sur mobile, la liste s'ouvre via le bouton cameras et les lecteurs sont empiles.

## Architecture

- React / TypeScript pour l'interface.
- Node.js / Express pour l'inventaire Meraki et la signalisation video authentifiee.
- MediaMTX 1.21.3 pour RTSP TCP vers WebRTC, sans reencodage ni enregistrement.
- Caddy pour HTTPS avec une autorite de certification locale.

La cle API reste sur le serveur. Les navigateurs ne recoivent pas les URL RTSP.
MediaMTX ouvre une connexion quand un lecteur demande une camera et la ferme
10 secondes apres le depart du dernier lecteur. Plusieurs navigateurs partagent
la meme connexion RTSP. La limite est quatre emplacements par navigateur,
pas quatre cameras au total pour tous les utilisateurs.

## Prerequis

- VM Ubuntu avec Docker Engine et le plugin Docker Compose v2.
- IP LAN fixe pour la VM, acces aux cameras en TCP 9000.
- API Meraki activee, cle avec droits de lecture sur l'organisation et ses cameras.
- Identifiant de l'organisation (disponible via GET /api/v1/organizations).
- External RTSP active sur chaque camera dans le Dashboard Meraki.
- Flux H.264 compatible WebRTC, sans B-frames ; Chrome ou Edge recent.

MV12 et MV13 sont documentees compatibles RTSP. Verifier les references exactes
et les firmwares des autres modeles. Aucune modification des cameras n'est faite
par l'application. Une camera RTSP desactivee produit un message explicite.

## Deploiement Ubuntu

Dans le repertoire du projet :

```bash
cp .env.example .env
chmod 600 .env
```

Renseigner `.env` localement, sans partager la cle API :

| Variable | Valeur |
| --- | --- |
| MERAKI_API_KEY | Cle Meraki privee |
| MERAKI_ORGANIZATION_ID | Identifiant de l'organisation |
| APP_USERNAME | Identifiant de connexion, par defaut admin |
| APP_PASSWORD | Mot de passe unique d'au moins 12 caracteres |
| SERVER_LAN_IP | IP LAN de la VM, par exemple 192.168.1.20 |
| HTTPS_PORT | Port HTTPS publie, par defaut 443 |
| DEMO_MODE | false pour les vraies cameras |

Pour les valeurs contenant `$`, `#` ou des espaces, utiliser des guillemets simples
dans `.env`. Ne pas partager la sortie de `docker compose config` sans `--quiet` :
elle peut afficher les secrets substitues.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Ouvrir `https://192.168.1.20` (remplacer par SERVER_LAN_IP). Si HTTPS_PORT n'est
pas 443, ajouter le port a l'URL. Le navigateur demande APP_USERNAME / APP_PASSWORD.

### Certificat HTTPS

Caddy cree une autorite locale. Pour eviter les avertissements et obtenir un contexte
HTTPS de confiance, exporter son certificat public puis l'installer comme autorite
de confiance sur les postes qui affichent le mur :

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./videowall-root.crt
```

Ne distribuer que ce certificat public, jamais les cles de Caddy. Sur Windows,
importer le certificat dans les autorites de certification racines de confiance
(utilisateur courant ou deploiement gere par l'administrateur). Pour un domaine
avec certificat d'entreprise, adapter `deploy/Caddyfile`.

### Reseau

| Sens | Port | Fonction |
| --- | --- | --- |
| Navigateurs vers VM | TCP 443, ou HTTPS_PORT | Interface et signalisation WHEP |
| Navigateurs vers VM | UDP 8189, TCP 8189 en secours | Media WebRTC chiffre |
| VM vers cameras | TCP 9000 | RTSP non chiffre, sur LAN protege |
| VM vers api.meraki.com | TCP 443 | Inventaire et parametres |

Les ports 9997 et 8889 ne sont pas publies. Le controle MediaMTX est accessible
uniquement sur le reseau Docker media, partage avec le backend. Il n'y a pas
d'authentification additionnelle a l'interieur de ce reseau : ne pas y attacher
d'autres conteneurs non fiables. Aucun droit de publication video n'est accorde.
L'application utilise HTTP Basic sur HTTPS, avec limitation des tentatives et
protection contre les mutations cross-origin. Cette version utilise un compte partage,
sans roles par utilisateur. Le point /healthz est public et ne divulgue aucun secret.

Autoriser les ports uniquement depuis les reseaux de confiance. Docker utilise
ses propres regles de publication : ne pas compter uniquement sur UFW. Appliquer
les restrictions au pare-feu de l'hyperviseur ou a la chaine DOCKER-USER.
L'acces Internet et TURN ne sont pas configures dans cette version LAN.

## Validation Avec Une Camera

1. Verifier son URL RTSP dans VLC depuis le LAN.
2. Ouvrir le videowall, choisir un emplacement puis cette camera.
3. Verifier l'etat Live et l'image ; ajouter ensuite trois autres cameras.
4. Retirer les cameras et verifier l'arret des connexions RTSP apres 10 secondes.
5. Ouvrir un second navigateur pour verifier le partage des connexions.

```bash
docker compose logs --tail=100 app mediamtx caddy
docker stats
```

Liste vide : verifier l'organisation, les droits API et les reseaux camera.
Liste presente mais aucune video : verifier TCP 9000, SERVER_LAN_IP, le port 8189
et le codec. MediaMTX ne reencode pas : plus de CPU ne corrige pas automatiquement
un codec incompatible. Un transcodeur FFmpeg pourra etre ajoute apres identification
du besoin. Les IP camera doivent etre privees IPv4 RFC1918.

L'inventaire est mis en cache 60 secondes et actualise a la demande. Les statuts
proviennent du dernier inventaire ; l'etat Live depend de la connexion WebRTC.
Il n'y a ni historique video ni audio dans cette premiere version.

## Demonstration Et Developpement

DEMO_MODE=true fournit six cameras fictives et un clip public CC0 (MDN, flower.mp4)
explicitement marque Demonstration. Aucun appel Meraki ni RTSP n'est effectue.
Ce mode ne valide pas le live ; le clip necessite Internet.

Installer Node.js 24, renseigner APP_PASSWORD dans `.env` et definir DEMO_MODE=true
pour tester sans cameras :

```bash
npm ci
npm run dev
```

Interface : http://localhost:5173. API : port 3000. Le navigateur demande le compte
configure. Le serveur de developpement est reserve aux tests sur reseau de confiance.
Pour tester les cameras hors Docker, lancer aussi MediaMTX avec 9997 / 8889 sur
localhost et l'IP LAN annoncee aux lecteurs. Ne pas exposer les ports de controle.

```bash
npm test
npm run lint
npm run build
```

La construction Docker execute les tests, le lint et les compilations. Les tests
backend utilisent des doubles Meraki / MediaMTX et controlent les secrets, les droits,
les chemins a la demande et la fermeture des sessions WHEP. Les tests YAML verifient
les contraintes de deploiement mais ne remplacent pas `docker compose config --quiet`
ni une execution sur la VM Ubuntu avec les vraies cameras.
