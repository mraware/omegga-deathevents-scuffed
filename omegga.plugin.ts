import OmeggaPlugin, { OL, PS, PC, PluginInterop } from './omegga';

type Config = { "poll-rate": number };
type Storage = { subscriberNames: string[] };

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;
  subscribers: PluginInterop[];
  deathCheckInterval: NodeJS.Timer;
  clearPawnDataCacheInterval: NodeJS.Timer;
  deathTracker: String[] = [];
  pawnDataCache: Map<string, any>;
  controllerKillsCache: Map<string, any>;

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    this.subscribers = [];
    this.pawnDataCache = new Map<string, any>();
    this.controllerKillsCache = new Map<string, any>();
  }

  async init() {
    const subscriberNames = await this.store.get("subscriberNames") || [];
    for (const subscriberName of subscriberNames) {
      await this.subscribe(subscriberName);
    }
    this.deathCheckInterval = setInterval(this.deathCheck, 100);
    this.clearPawnDataCacheInterval = setInterval(this.clearPawnDataCache, 60000);
  }

  async stop() {
    clearInterval(this.deathCheckInterval);
    clearInterval(this.clearPawnDataCacheInterval);
  }

  subscribe = async (pluginName) => {
    if (!this.subscribers.find((subscriber) => subscriber.name === pluginName)) {
      const plugin = await this.omegga.getPlugin(pluginName);
      if (plugin) {
        console.log(`${pluginName} subscribing`)
        this.subscribers.push(
          await this.omegga.getPlugin(pluginName)
        );
      } else {
        console.log(`${pluginName} is not enabled, removing subscription`)
      }
    }
    await this.store.set("subscriberNames", this.subscribers.map(subscriber => subscriber.name));
  }

  unsubscribe = async (pluginName) => {
    console.log(`${pluginName} unsubscribing`)
    this.subscribers = this.subscribers.filter((subscriber) => !(subscriber.name === pluginName))
    await this.store.set("subscriberNames", this.subscribers.map(subscriber => subscriber.name));
  }

  deathCheck = async () => {
    if (this.subscribers.length > 0 && this.omegga.getPlayers().length > 0) {
      const pawnInfo = await this.getPawnInfo();
      if (pawnInfo) {
        const { controllers, deads, lastHits, kills } = pawnInfo;

        const deaths = [];
        const spawns = [];
        const killsEvent = [];


        kills.forEach(({ controller, kills }) => {
          const controllerKills = this.controllerKillsCache.get(controller);
          if (controllerKills) {
            this.controllerKillsCache.set(controller, { ...controllerKills, kills })
          } else {
            this.controllerKillsCache.set(controller, { kills, killsLastKill: kills })
          }
        })

        controllers.forEach(({ pawn, controller }) => {
          const pawnData = this.pawnDataCache.get(pawn);
          if (!pawnData) {
            const player = this.omegga.getPlayer(controller);
            if (player) {
              spawns.push({
                pawn,
                player
              })
              this.pawnDataCache.set(pawn, { pawn, controller, player, lastActive: Date.now() })
            }
          } else {
            this.pawnDataCache.set(pawn, { ...pawnData, lastActive: Date.now() })
          }
        })

        lastHits.forEach(({ pawn, hitter }) => {
          const pawnData = this.pawnDataCache.get(pawn);
          if (pawnData) {
            this.pawnDataCache.set(pawn, { ...pawnData, hitter: hitter, lastActive: Date.now() })
          }
        })

        deads.forEach(({ pawn, dead }) => {
          const pawnData = this.pawnDataCache.get(pawn);
          if (pawnData) {
            if (dead && !pawnData.dead) {
              let killer;
              if (pawnData.hitter) {
                const killerKills = this.controllerKillsCache.get(pawnData.hitter);
                if (killerKills && killerKills.kills > killerKills.killsLastKill) {
                  killer = { ...this.omegga.getPlayer(pawnData.hitter), kills: killerKills.kills }
                  this.controllerKillsCache.set(pawnData.hitter, { kills: killerKills.kill, killsLastKill: killerKills.kills })
                }
              }
              deaths.push({
                pawn: pawnData.pawn,
                player: pawnData.player,
                killer: killer
              })
            }
            this.pawnDataCache.set(pawn, { ...pawnData, dead, lastActive: Date.now() })
          }
        })

        deaths.forEach(death => {
          this.subscribers.forEach(subscriber => {
            subscriber.emitPlugin('ondeath:death', death);
          })
        })
        killsEvent.forEach(kill => {
          this.subscribers.forEach(subscriber => {
            subscriber.emitPlugin('ondeath:kill', kill);
          })
        })
        spawns.forEach(spawn => {
          this.subscribers.forEach(subscriber => {
            subscriber.emitPlugin('ondeath:spawn', spawn);
          })
        })
      }
    }
  }

  // [2022.04.23-21.43.36:264][474]LogConsoleCmd: GetAll BP_PlayerState_C LeaderboardData
  // [2022.04.23-21.43.36:264][474]0) BP_PlayerState_C /Game/Maps/Plate/Plate.Plate:PersistentLevel.BP_PlayerState_C_2147482495.LeaderboardData =
  // [2022.04.23-21.43.36:264][474]	0: 0
  // [2022.04.23-21.43.36:264][474]	1: 9
  // [2022.04.23-21.43.36:264][474]	2: 5
  // [2022.04.23-21.43.36:264][474]1) BP_PlayerState_C /Game/Maps/Plate/Plate.Plate:PersistentLevel.BP_PlayerState_C_2147482381.LeaderboardData =
  // [2022.04.23-21.43.36:264][474]	0: 1
  // [2022.04.23-21.43.36:264][474]	1: 4
  // [2022.04.23-21.43.36:264][474]	2: 9

  async getPawnInfo() {
    const pawnRegExp =
      /(?<index>\d+)\) BP_PlayerController_C .+?PersistentLevel\.(?<controller>BP_PlayerController_C_\d+)\.Pawn = (?:None|BP_FigureV2_C'.+?:PersistentLevel.(?<pawn>BP_FigureV2_C_\d+)')?$/;
    const deadFigureRegExp =
      /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.bIsDead = (?<dead>(True|False))$/;
    const lastHitRegExp =
      /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.LastHitBy = (?:None|BP_PlayerController_C'.+?:PersistentLevel.(?<controller>BP_PlayerController_C_\d+)')?$/;
    const playerStateRegExp =
      /(?<index>\d+)\) BP_PlayerController_C .+?PersistentLevel\.(?<controller>BP_PlayerController_C_\d+)\.PlayerState = (?:None|BP_PlayerState_C'.+?:PersistentLevel.(?<playerState>BP_PlayerState_C_\d+)')?$/;

    const playerStateLeaderboardRegExp =
      /^(?<index>\d+)\) BP_PlayerState_C (.+):PersistentLevel.(?<playerState>BP_PlayerState_C_\d+)\.LeaderboardData =$/;
    const leaderboardRegExp =
      /^\t(?<index>\d+): (?<column>\d+)$/;


    let [pawns, leaderboards, playerStates, lastHits, deadFigures] = await Promise.all([
      this.omegga.watchLogChunk<RegExpMatchArray>(
        'GetAll BP_PlayerController_C Pawn',
        pawnRegExp,
        {
          first: 'index',
          timeoutDelay: 5000,
          afterMatchDelay: 250
        }
      ),
      this.omegga.watchLogArray<
        { index: string; ruleset: string },
        { index: string; state: string }
      >(
        'GetAll BP_PlayerState_C LeaderboardData',
        playerStateLeaderboardRegExp,
        leaderboardRegExp
      ),
      this.omegga.watchLogChunk<RegExpMatchArray>(
        'GetAll BP_PlayerController_C PlayerState',
        playerStateRegExp,
        {
          first: 'index',
          timeoutDelay: 5000,
          afterMatchDelay: 250
        }
      ),
      this.omegga.watchLogChunk<RegExpMatchArray>(
        'GetAll BP_FigureV2_C LastHitBy',
        lastHitRegExp,
        {
          first: 'index',
          timeoutDelay: 5000,
          afterMatchDelay: 250
        }
      ),
      this.omegga.watchLogChunk<RegExpMatchArray>(
        'GetAll BP_FigureV2_C bIsDead',
        deadFigureRegExp,
        {
          first: 'index',
          timeoutDelay: 5000,
          afterMatchDelay: 250
        }
      )
    ]);

    const kills = leaderboards.map((leaderboard) => ({
      controller: playerStates.find(playerState => playerState?.groups?.playerState === leaderboard?.item?.playerState)?.groups?.controller,
      playerState: leaderboard?.item?.playerState,
      kills: +leaderboard?.members[1]?.column
    }))

    // these results are invalid
    for (let i = 0; i < pawns.length; i++) {
      const pawn = pawns[i]
      if (!lastHits.find(lastHit => pawn?.groups?.pawn === lastHit?.groups?.pawn) ||
        !deadFigures.find(dead => pawn?.groups?.pawn === dead?.groups?.pawn) ||
        !kills.find(kill => pawn?.groups?.controller === kill.controller)
      ) {
        return;
      }
    }

    if (playerStates.length != leaderboards.length ||
      lastHits.length != deadFigures.length ||
      pawns.length != playerStates.length
    ) {
      return;
    }

    return (
      {
        controllers: pawns.map((pawn) => ({
          pawn: pawn.groups.pawn,
          controller: pawn.groups.controller
        })),
        deads: deadFigures.map((deadFigure) => ({
          pawn: deadFigure.groups.pawn,
          dead: deadFigure.groups.dead === "True"
        })),
        lastHits: lastHits.map((lastHit) => ({
          pawn: lastHit.groups.pawn,
          hitter: lastHit.groups.controller
        })),
        kills
      }
    );
  }

  clearPawnDataCache = () => {
    const now = Date.now()
    for (const key in this.pawnDataCache.keys()) {
      const pawnData = this.pawnDataCache[key];
      if (pawnData.lastActive < Date.now() - 60000) {
        this.pawnDataCache.delete(key);
      }
    }
  }

  async pluginEvent(event: string, from: string, ...args: any[]) {
    if (event === 'ondeath:subscribe') {
      this.subscribe(from);
    }
    if (event === 'ondeath:unsubscribe') {
      this.unsubscribe(from);
    }
  }
}