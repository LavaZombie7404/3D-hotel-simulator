// ---------------------------------------------------------------------------
// Toate constantele de balans si de layout intr-un singur loc.
// ---------------------------------------------------------------------------

// --- Geometrie cladire ---
export const ROOM_W = 6;          // latimea unei camere (pe X)
export const ROOM_D = 7;          // adancimea unei camere (pe Z)
export const CORRIDOR_W = 4;      // latimea holului
export const HALF_C = CORRIDOR_W / 2;
export const WALL_T = 0.22;       // grosime pereti
export const WALL_H = 3.0;        // inaltime pereti
export const SLAB_T = 0.3;        // grosime placa de etaj
export const FLOOR_H = 4;         // distanta dintre etaje

export const ROOMS_PER_SIDE = 4;                        // camere pe fiecare latura a holului
export const ROOMS_PER_FLOOR = ROOMS_PER_SIDE * 2;      // 8
export const FLOORS = 3;
export const TOTAL_ROOMS = ROOMS_PER_FLOOR * FLOORS;    // 24

export const CORRIDOR_X0 = 0;
export const CORRIDOR_X1 = ROOMS_PER_SIDE * ROOM_W;     // 24
export const BUILD_Z = HALF_C + ROOM_D;                 // 9  (jumatate din adancimea cladirii)

export const LOBBY_X0 = -18;      // peretele din fata al lobby-ului (cu intrarea)
export const UPPER_X0 = -6;       // unde incepe placa etajelor superioare (palierul liftului)
export const DOOR_W = 1.8;        // golul usii in peretele dinspre hol

// --- Lift ---
export const ELEV_X = -2.6;
export const ELEV_HW = 1.9;       // jumatate din latura casei liftului

// --- Receptie ---
export const DESK_X = -10;        // centrul biroului de receptie
export const DESK_Z = 6.2;
export const DESK_W = 6;
export const QUEUE_X = -10;       // primul loc la coada
export const QUEUE_Z = 4.4;
export const QUEUE_STEP = 1.35;   // distanta intre oameni la coada
export const MAX_QUEUE = 10;

// --- Zona de asteptare din lobby (cand nu e nicio camera libera) ---
export const WAIT_X = -13;
export const WAIT_Z = -3.5;
export const WAIT_COLS = 4;
export const WAIT_STEP = 1.6;
export const MAX_WAIT = 16;

// --- Oaspeti ---
export const MAX_GUESTS = 180;
export const MAX_WP = 10;         // waypoint-uri maxime pe traseu
export const WALK_SPEED = 3.4;    // m/s
export const LIFT_SPEED = 4.5;    // m/s pe verticala
export const SPAWN_X = -30;       // in afara ecranului, de unde vin
export const GUEST_R = 0.26;

// --- Economie ---
export const START_MONEY = 60;
export const CHECK_IN_FEE = 1;    // $ platit la receptie de fiecare client
export const PAY_PER_LEVEL = 4;   // $ la check-out = PAY_PER_LEVEL * nivelul camerei
export const MAX_LEVEL = 8;
export const STAY_TIME = 16;      // secunde de cazare
export const SERVICE_TIME = 1.1;  // secunde per client la receptie (fara chelner)
export const LOBBY_PATIENCE = 25; // cat asteapta in lobby dupa o camera libera

export const UNLOCK_BASE = 25;
export const UNLOCK_GROWTH = 1.26;
export const UPGRADE_BASE = 35;
export const UPGRADE_GROWTH = 1.7;
export const FLOOR_COST = [0, 450, 1800];

// --- Sosiri ---
export const ARRIVE_MIN = 0.9;
export const ARRIVE_MAX = 8.0;
export const ARRIVE_PER_ROOM = 0.42;

// --- Simulare ---
export const FIXED_DT = 1 / 60;
export const MAX_STEPS = 8;       // limita pasi de simulare pe cadru (anti spiral-of-death)

// --- Chelnerul (jucatorul) ---
export const PLAYER_SPEED = 6.2;      // m/s, mai rapid decat oaspetii
export const PLAYER_R = 0.32;         // raza pentru coliziunea cu peretii
export const RIDE_TIME = 0.7;         // durata unei curse cu liftul

// Cereri de room service de la clientii cazati.
export const REQ_DELAY_MIN = 2.0;     // dupa cat timp de la cazare pot cere
export const REQ_DELAY_MAX = 7.0;
export const REQ_TTL = 14;            // cat astepta clientul dupa chelner
export const TIP_PER_LEVEL = 3;       // bacsis = TIP_PER_LEVEL * nivelul camerei

// Zona din fata receptiei: cat timp stai in ea, check-in-ul merge mai repede.
export const DESK_ZONE_X = DESK_X;
export const DESK_ZONE_Z = DESK_Z - 2.0;
export const DESK_ZONE_R = 2.6;
export const SERVICE_BOOST = 0.4;     // 1.1s -> 0.44s cat timp esti la birou
