// ---------------------------------------------------------------------------
// Every balance and layout constant in one place.
// ---------------------------------------------------------------------------

// --- Building geometry ---
export const ROOM_W = 6;          // room width (along X)
export const ROOM_D = 7;          // room depth (along Z)
export const CORRIDOR_W = 4;      // corridor width
export const HALF_C = CORRIDOR_W / 2;
export const WALL_T = 0.22;       // wall thickness
export const WALL_H = 3.0;        // wall height
export const SLAB_T = 0.3;        // floor slab thickness
export const FLOOR_H = 4;         // distance between floors

export const ROOMS_PER_SIDE = 4;                        // rooms on each side of the corridor
export const ROOMS_PER_FLOOR = ROOMS_PER_SIDE * 2;      // 8
export const FLOORS = 6;          // ground floor + floors 1-5
export const TOTAL_ROOMS = ROOMS_PER_FLOOR * FLOORS;    // 48

export const CORRIDOR_X0 = 0;
export const CORRIDOR_X1 = ROOMS_PER_SIDE * ROOM_W;     // 24
export const BUILD_Z = HALF_C + ROOM_D;                 // 9  (half the building depth)

export const LOBBY_X0 = -18;      // front wall of the lobby (holds the entrance)
export const UPPER_X0 = -8;       // where the upper floor slabs start (lift landing)
export const DOOR_W = 1.8;        // doorway gap in the corridor-facing wall

// --- Lift ---
// The shaft sits off to one side of the lobby rather than straddling the
// straight line from the lobby to the corridor - standing on that line meant
// constantly bumping into it, and stepping into the cabin by accident.
export const ELEV_X = -2.6;
export const ELEV_Z = -5.5;
export const ELEV_HW = 1.9;       // half width of the shaft
export const CABIN_HW = 1.55;     // half width of the cabin
export const LIFT_CAPACITY = 14;  // base seats in the cabin (grow with boosters)
export const LIFT_CAPACITY_MAX = 30;
export const LIFT_CAR_SPEED = 9;  // m/s vertically
export const LIFT_DOOR_TIME = 0.4;// how long the doors take to open or close
export const LIFT_OPEN_WAIT = 0.7;// how long it holds the doors open at a stop
export const LIFT_WAIT_GAP = 0.9; // how far from the cabin people wait

// --- Reception ---
export const DESK_X = -10;        // centre of the reception desk
export const DESK_Z = 6.2;
export const DESK_W = 6;
export const QUEUE_X = -10;       // first spot in the queue
export const QUEUE_Z = 4.4;
export const QUEUE_STEP = 1.35;   // spacing between people in the queue
export const MAX_QUEUE = 12;      // beyond this, guests will not even join the line

// --- Lobby waiting area (used when no room is free) ---
export const WAIT_X = -13;
export const WAIT_Z = -3.5;
export const WAIT_COLS = 4;
export const WAIT_STEP = 1.6;
export const MAX_WAIT = 16;

// --- Guests ---
export const MAX_GUESTS = 300;
export const MAX_WP = 10;         // maximum waypoints in a path
export const WALK_SPEED = 3.4;    // m/s
export const SPAWN_X = -30;       // off screen, where they come from
export const GUEST_R = 0.26;

// --- Economy ---
export const START_MONEY = 60;
export const CHECK_IN_FEE = 1;    // $ every guest pays at the desk
export const PAY_PER_LEVEL = 4;   // $ at check-out = PAY_PER_LEVEL * room level
export const MAX_LEVEL = 8;
export const STAY_TIME = 16;      // seconds a guest stays in the room
export const SERVICE_TIME = 1.1;  // seconds per check-in (without the waiter)
export const LOBBY_PATIENCE = 25; // how long they wait in the lobby for a free room
export const QUEUE_PATIENCE = 30; // safety net for anyone who never reaches the desk

export const UNLOCK_BASE = 25;
export const UNLOCK_GROWTH = 1.22;
export const UPGRADE_BASE = 35;
export const UPGRADE_GROWTH = 1.7;
export const FLOOR_COST = [0, 450, 1800, 6000, 20000, 60000];

// The upper floors do not exist from the start: they appear after N rebirths.
export const FLOOR_REBIRTH_REQ = [0, 0, 0, 10, 15, 20];

// --- Rebirth and prestige ---
// One rebirth = one booster. The goal rises with every rebirth.
export const REBIRTH_BASE = 5000;
export const REBIRTH_STEP = 0.5;      // goal = REBIRTH_BASE * (1 + rebirths * 0.5)
export const BOOST_BONUS = 0.25;      // +25% on all income, per booster
export const BOOST_START_MONEY = 60;  // extra starting cash, by root of booster count

// Prestige: after 20 rebirths, multiply the boosters you already have by 10.
export const PRESTIGE_REBIRTHS = 20;
export const PRESTIGE_MULT = 10;

// Boosters also speed up the flow of guests — otherwise the new floors would
// sit empty, because reception and arrivals would stay the real bottleneck.
export const FLOW_PER_BOOST = 0.05;
export const FLOW_MAX = 6;

// --- Arrivals ---
export const ARRIVE_MIN = 0.9;
export const ARRIVE_MAX = 8.0;
export const ARRIVE_PER_ROOM = 0.42;

// --- Simulation ---
export const FIXED_DT = 1 / 60;
export const MAX_STEPS = 8;       // cap on simulation steps per frame (anti spiral-of-death)

// --- The waiter (the player) ---
export const PLAYER_SPEED = 6.2;      // m/s, a bit faster than the guests
export const PLAYER_R = 0.32;         // radius used for wall collisions

// Room service requests from guests who are checked in.
export const REQ_DELAY_MIN = 2.0;     // how long after check-in they may ring
export const REQ_DELAY_MAX = 7.0;
export const REQ_TTL = 14;            // how long the guest waits for the waiter
export const TIP_PER_LEVEL = 3;       // tip = TIP_PER_LEVEL * room level

// After a guest checks out the room is dirty and cannot be let again.
// Housekeeping clears it on its own, slowly; walking in cleans it at once.
// The wait shrinks as boosters grow, so late hotels are not choked by it.
export const CLEAN_TIME = 10;         // seconds for housekeeping to do it
export const CLEAN_PAY_PER_LEVEL = 1; // small payment for cleaning it yourself

// --- Restaurant ---
// A wing off the south side of the lobby. Guests eat on their way out, which
// turns the lobby into a second source of income instead of just a corridor.
export const REST_X0 = -17;
export const REST_X1 = -3;
export const REST_Z0 = -21;      // far wall
export const REST_Z1 = -9.5;     // opens into the lobby
export const REST_DOOR_X = -11;  // middle of the gap in the lobby wall
export const REST_DOOR_W = 3.4;

export const MAX_SEATS = 18;
export const SEAT_COLS = 6;
export const SEATS_PER_LEVEL = 2;      // seats = SEATS_PER_LEVEL * level
export const DINE_TIME = 9;            // seconds at the table
export const DINE_CHANCE = 0.55;       // how often a departing guest stops to eat
export const DINE_PAY_PER_LEVEL = 5;   // $ per level, on top of the room
export const REST_COST_BASE = 400;
export const REST_COST_GROWTH = 1.8;
export const REST_MAX_LEVEL = 9;

// --- Hired staff ---
// Porters answer room service, cleaners turn rooms around. Each hire works a
// single floor. They are slower than you, so automation frees you up without
// making you redundant - reception is still yours alone.
export const MAX_STAFF = 48;
export const MAX_STAFF_PER_KIND = 3;   // per floor, per kind
export const STAFF_SPEED = 2.6;        // m/s, against the player's 6.2
export const STAFF_WORK_PAUSE = 1.0;   // seconds spent doing the job
export const STAFF_COST_BASE = 220;
export const STAFF_COST_GROWTH = 1.45;

// The circle in front of the desk: standing in it speeds up check-in.
export const DESK_ZONE_X = DESK_X;
export const DESK_ZONE_Z = DESK_Z - 2.0;
export const DESK_ZONE_R = 2.6;
export const SERVICE_BOOST = 0.4;     // 1.1s -> 0.44s while you are at the desk
