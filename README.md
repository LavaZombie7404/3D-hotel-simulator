# 3D Hotel Simulator

Simulator 3D de hotel cu vedere **top-down**, rulat in browser cu Three.js.
Fara bundler, fara CDN — se deschide pe un localhost si merge.

![gameplay](tools/shots/21-roomservice.png)

## Cum il pornesti

```bash
npm install     # doar three (+ playwright, optional, pentru teste)
npm start       # http://localhost:8080
```

Serverul e `server.js`, un static server fara dependinte (Node 18+).
Poti da si alt port: `node server.js 3000`.

## Cum se joaca

Esti **chelnerul** — omuletul in vesta bordo, cu tava si cu cercul auriu sub
picioare. Hotelul merge si fara tine, dar merge prost.

### Clientii

1. Vin pe drum, intra in lobby si se aseaza la coada la receptie.
2. La check-in fiecare client iti plateste **$1**.
3. Primeste apoi **cea mai buna camera libera** — un singur client per camera.
4. Urca cu liftul, sta cazat ~16 secunde, iar la check-out plateste
   **$4 x nivelul camerei** (nivel 1 = $4, nivel 8 = $32).
5. Daca nu e nicio camera libera, asteapta in lobby 25 de secunde si apoi
   pleaca — apare la "Clienti pierduti".

### Ce faci tu

- **Room service.** Cat sunt cazati, clientii cer chelnerul: deasupra camerei
  apare un romb auriu. Intri in camera si incasezi bacsis
  **$3 x nivelul camerei**. Ai 14 secunde pana clientul renunta.
- **Receptie.** Cat timp stai in cercul auriu din fata biroului, check-in-ul
  merge de 2.5 ori mai repede (1.1s → 0.44s per client). Cand hotelul e plin,
  coada creste mai repede decat o poate goli receptia singura — asta e
  momentul in care trebuie sa fii acolo.

Deci alergi intre birou si camere: stai la receptie cat se aduna coada, apoi
dai o tura pe etaje sa strangi bacsisul.

### Banii

Ii bagi inapoi in hotel: deblochezi camere noi, le urci nivelul si deschizi
etajele 1 si 2. Cu cat sunt mai multe camere deblocate, cu atat vin clientii
mai des.

| Actiune | Cost |
|---|---|
| Deblocare camera | $25 x 1.26^(camere deja deblocate) |
| Upgrade camera (nivel N → N+1) | $35 x 1.7^(N-1) |
| Deschidere etaj 1 / etaj 2 | $450 / $1800 |

Nivelul camerei se vede din culoarea podelei si din mobilierul care apare pe
masura ce urci: pat → noptiera → birou → canapea → TV → planta → covor.
Usile sunt **verzi** cand camera e libera, **rosii** cand e ocupata si
**gri** cand e blocata.

Nivelul mai mare inseamna si bacsis mai mare, nu doar chirie mai mare.

## Comenzi

| | |
|---|---|
| `W` `A` `S` `D` / sageti | misca chelnerul (relativ la cum e intoarsa camera) |
| `E` (stand in lift) | urci un etaj |
| `1` `2` `3` in lift | mergi direct la etajul ala |
| `1` `2` `3` in afara liftului | doar muta privirea pe alt etaj |
| `F` | camera urmareste chelnerul (porneste singura la prima miscare) |
| Click stanga (drag) | roteste camera |
| Click dreapta (drag) | deplaseaza |
| Rotita | zoom |
| Click pe o camera | o selecteaza (panoul din dreapta-jos) |

Nu exista control de viteza: simularea merge mereu in timp real.

Se vede un singur etaj o data — altfel, la vedere de sus, etajele de deasupra
ar acoperi tot. Cand iei liftul, vizualizarea te urmeaza automat.

## Cum e facut optimizat

Scena intreaga se deseneaza in ~11-21 draw call-uri, indiferent de cati
oaspeti sunt in hotel:

- **Toti oaspetii = 2 draw call-uri.** Un `InstancedMesh` pentru corpuri si
  unul pentru capete, cu capacitate prealocata (180) si culoare per instanta.
- **Arhitectura statica e fuzionata.** Peretii, placile si lemnul fiecarui
  etaj sunt unite cu `mergeGeometries` in cate o singura geometrie, cu
  `matrixAutoUpdate = false`.
- **Se randeaza doar etajul activ.** Celelalte etaje au `visible = false`, deci
  nici nu ajung in pipeline.
- **Podelele, usile si mobilierul sunt instantiate** si se reconstruiesc doar
  cand chiar se schimba ceva (`roomsDirty` / `doorsDirty`), nu in fiecare cadru.
- **Zero alocari in bucla.** Toata starea camerelor si a oaspetilor sta in
  typed arrays (structure-of-arrays); `Object3D`, `Color` si `Vector3` de lucru
  sunt reutilizate. Deci practic nu se declanseaza garbage collector in joc.
- **Pas fix de simulare** (1/60 s) cu acumulator, decuplat de rata de randare —
  jocul se comporta identic la 60 sau la 144 Hz, indiferent cate cadre apuca sa
  deseneze placa video.
- **Materiale Lambert**, nu Standard/PBR — mult mai ieftin, si arata bine cu
  lumina hemisferica + directionala. Umbrele sunt dezactivate intentionat.
- **HUD-ul se scrie la 5 Hz**, nu la fiecare cadru; textele `+$` folosesc un
  pool fix de elemente DOM reciclate.
- **Raycast doar la click**, niciodata per cadru.
- **Coliziunile chelnerului refolosesc chiar dreptunghiurile peretilor**
  generati de `build.js`, deci golurile de usa sunt gratis si nu exista un al
  doilea model de coliziune care sa se desincronizeze de geometrie.
  Deplasarea e impartita in pasi mai mici decat grosimea unui perete, ca un
  cadru lung sa nu-l arunce prin zid.

## Structura

```
index.html        HUD + stiluri
server.js         static server fara dependinte
src/config.js     toate constantele de layout si de balans
src/world.js      starea camerelor (typed arrays) + economia
src/build.js      constructia scenei, geometrie fuzionata, instante
src/guests.js     simularea oaspetilor + randarea instantiata
src/player.js     chelnerul: miscare, coliziuni, lift, room service
src/ui.js         HUD-ul si textele flotante
src/main.js       renderer, camera top-down, input, bucla de joc
vendor/           three.js + OrbitControls + BufferGeometryUtils (local)
tools/            teste automate in Playwright
```

## Teste

```bash
npm start                      # intr-un terminal
node tools/smoke.mjs           # incarca jocul, lasa sa ruleze, verifica consola
node tools/upper-floors.mjs    # deblocheaza tot si verifica liftul + etajele
node tools/waiter.mjs          # miscare, coliziuni, lift, bacsis, boost la receptie
```

Toate trei fac capturi de ecran in `tools/shots/`.

Pentru reglaje din consola browserului exista `window.__hotel`:
`__hotel.give(5000)`, `__hotel.unlockFloor(1)`, `__hotel.player`,
`__hotel.setSpeed(4)` (accelerarea a ramas doar aici, pentru teste).
