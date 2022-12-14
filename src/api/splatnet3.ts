import createDebug from 'debug';
import fetch, { Response } from 'node-fetch';
import { BankaraBattleHistoriesRefetchResult, BankaraBattleHistoriesRefetchVariables, GraphQLRequest, GraphQLResponse, GraphQLSuccessResponse, KnownRequestId, LatestBattleHistoriesRefetchResult, LatestBattleHistoriesRefetchVariables, MyOutfitInput, PagerUpdateBattleHistoriesByVsModeResult, PagerUpdateBattleHistoriesByVsModeVariables, PrivateBattleHistoriesRefetchResult, PrivateBattleHistoriesRefetchVariables, RegularBattleHistoriesRefetchResult, RegularBattleHistoriesRefetchVariables, RequestId, ResultTypes, VariablesTypes, XBattleHistoriesRefetchResult, XBattleHistoriesRefetchVariables } from 'splatnet3-types/splatnet3';
import { timeoutSignal } from '../util/misc.js';
import { WebServiceToken } from './coral-types.js';
import CoralApi from './coral.js';
import { NintendoAccountUser } from './na.js';
import { BulletToken } from './splatnet3-types.js';
import { defineResponse, ErrorResponse, HasResponse, ResponseSymbol } from './util.js';

const debug = createDebug('nxapi:api:splatnet3');
const debugGraphQl = createDebug('nxapi:api:splatnet3:graphql');
debugGraphQl.enabled = true;
const debugUpgradeQuery = createDebug('nxapi:api:splatnet3:upgrade-query');

export const SPLATNET3_WEBSERVICE_ID = 4834290508791808;
export const SPLATNET3_WEBSERVICE_URL = 'https://api.lp1.av5ja.srv.nintendo.net';
export const SPLATNET3_WEBSERVICE_USERAGENT = 'Mozilla/5.0 (Linux; Android 8.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/58.0.3029.125 Mobile Safari/537.36';

const languages = [
    'de-DE', 'en-GB', 'en-US', 'es-ES', 'es-MX', 'fr-CA',
    'fr-FR', 'it-IT', 'ja-JP', 'ko-KR', 'nl-NL', 'ru-RU',
    'zh-CN', 'zh-TW',
];

const SPLATNET3_URL = SPLATNET3_WEBSERVICE_URL + '/api';
const SHOULD_RENEW_TOKEN_AT = 300; // 5 minutes in seconds
const TOKEN_EXPIRES_IN = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

const AUTH_ERROR_CODES = {
    204: 'USER_NOT_REGISTERED',
    400: 'ERROR_INVALID_PARAMETERS',
    401: 'ERROR_INVALID_GAME_WEB_TOKEN',
    403: 'ERROR_OBSOLETE_VERSION',
    429: 'ERROR_RATE_LIMIT',
    500: 'ERROR_SERVER',
    503: 'ERROR_SERVER_MAINTENANCE',
    599: 'ERROR_SERVER',
} as const;

const REPLAY_CODE_REGEX = /^[A-Z0-9]{16}$/;

export const RequestIdSymbol = Symbol('RequestId');
export const VariablesSymbol = Symbol('Variables');

export type PersistedQueryResult<T> = GraphQLSuccessResponse<T> & PersistedQueryResultData;

export interface PersistedQueryResultData {
    [ResponseSymbol]: Response;
    [RequestIdSymbol]: KnownRequestId;
    [VariablesSymbol]: {};
}

enum MapQueriesMode {
    /** NXAPI_SPLATNET3_UPGRADE_QUERIES=0 - never upgrade persisted query IDs (not recommended) */
    NEVER,
    /** NXAPI_SPLATNET3_UPGRADE_QUERIES=1 - upgrade persisted query IDs that do not contain potentially breaking changes (not recommended) */
    ONLY_SAFE_NO_REJECT,
    /** NXAPI_SPLATNET3_UPGRADE_QUERIES=2 - upgrade persisted query IDs, but reject requests that contain potentially breaking changes */
    ONLY_SAFE,
    /** NXAPI_SPLATNET3_UPGRADE_QUERIES=3 - upgrade persisted query IDs, including requests that contain potentially breaking changes (default) */
    ALL,
}

export default class SplatNet3Api {
    onTokenShouldRenew: ((remaining: number, res: Response) => Promise<SplatNet3AuthData | void>) | null = null;
    onTokenExpired: ((res: Response) => Promise<SplatNet3AuthData | void>) | null = null;
    /** @internal */
    _renewToken: Promise<void> | null = null;

    graphql_strict = process.env.NXAPI_SPLATNET3_STRICT !== '0';

    protected constructor(
        public bullet_token: string,
        public version: string,
        public map_queries: Partial<Record<string, [/** new query ID */ string, /** unsafe */ boolean]>>,
        readonly map_queries_mode: MapQueriesMode,
        public language: string,
        public useragent: string,
    ) {}

    async fetch<T = unknown>(
        url: string, method = 'GET', body?: string | FormData, headers?: object,
        /** @internal */ _log?: string,
        /** @internal */ _attempt = 0
    ): Promise<HasResponse<T, Response>> {
        if (this._renewToken) {
            await this._renewToken;
        }

        const [signal, cancel] = timeoutSignal();
        const response = await fetch(SPLATNET3_URL + url, {
            method,
            headers: Object.assign({
                'User-Agent': this.useragent,
                'Accept': '*/*',
                'Referrer': 'https://api.lp1.av5ja.srv.nintendo.net/',
                'X-Requested-With': 'XMLHttpRequest',
                'authorization': 'Bearer ' + this.bullet_token,
                'content-type': 'application/json',
                'X-Web-View-Ver': this.version,
                'Accept-Language': this.language,
            }, headers),
            body,
            signal,
        }).finally(cancel);

        const version = response.headers.get('x-be-version');
        debug('fetch %s %s%s, response %s, server revision %s', method, url, _log ? ', ' + _log : '',
            response.status, version);

        if (response.status === 401 && !_attempt && this.onTokenExpired) {
            // _renewToken will be awaited when calling fetch
            this._renewToken = this._renewToken ?? this.onTokenExpired.call(null, response).then(data => {
                if (data) this.setTokenWithSavedToken(data);
            }).finally(() => {
                this._renewToken = null;
            });
            return this.fetch(url, method, body, headers, _log, _attempt + 1);
        }

        if (response.status !== 200) {
            throw new ErrorResponse('[splatnet3] Non-200 status code', response, await response.text());
        }

        const remaining = parseInt(response.headers.get('x-bullettoken-remaining') ?? '0');

        if (remaining <= SHOULD_RENEW_TOKEN_AT && !_attempt && this.onTokenShouldRenew) {
            // _renewToken will be awaited when calling fetch
            this._renewToken = this._renewToken ?? this.onTokenShouldRenew.call(null, remaining, response).then(data => {
                if (data) this.setTokenWithSavedToken(data);
            }).finally(() => {
                this._renewToken = null;
            });
        }

        const data = await response.json() as T;

        return defineResponse(data, response);
    }

    async persistedQuery<
        T = unknown, V = unknown,

        /** @private */
        _Id extends string = string,
        /** @private */
        _Result extends (T extends object ? T : _Id extends KnownRequestId ? ResultTypes[_Id] : unknown) =
            (T extends object ? T : _Id extends KnownRequestId ? ResultTypes[_Id] : unknown),
        /** @private */
        _Variables extends (V extends object ? V : _Id extends KnownRequestId ? VariablesTypes[_Id] : unknown) =
            (V extends object ? V : _Id extends KnownRequestId ? VariablesTypes[_Id] : unknown),
    >(id: _Id, variables: _Variables): Promise<PersistedQueryResult<_Result>> {
        id = this.getUpgradedPersistedQueryId(id) as _Id;

        const req: GraphQLRequest<_Variables> = {
            variables,
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: id,
                },
            },
        };

        const data = await this.fetch<GraphQLResponse<_Result>>('/graphql', 'POST', JSON.stringify(req), undefined,
            'graphql query ' + id);

        if (!('data' in data) || (this.graphql_strict && data.errors?.length)) {
            throw new ErrorResponse('[splatnet3] GraphQL error: ' + data.errors!.map(e => e.message).join(', '),
                data[ResponseSymbol], data);
        }

        for (const error of data.errors ?? []) {
            debugGraphQl('GraphQL error in query %s: %s', id, error.message, error);
        }

        Object.defineProperty(data, RequestIdSymbol, {value: id});
        Object.defineProperty(data, VariablesSymbol, {value: variables});

        return data as PersistedQueryResult<_Result>;
    }

    getPersistedQueryId(id: RequestId) {
        return this.getUpgradedPersistedQueryId(id, false);
    }

    private getUpgradedPersistedQueryId(id: string, reject = true) {
        if (this.map_queries_mode === MapQueriesMode.NEVER) return id;

        let new_id = id;
        let unsafe = false;

        while (this.map_queries[new_id]) {
            const [map_id, map_unsafe] = this.map_queries[new_id]!;

            if (map_unsafe && this.map_queries_mode === MapQueriesMode.ONLY_SAFE && reject) {
                throw new Error('[splatnet3] Updated persisted query ' + map_id + ' for ' + id +
                    ' contains potentially breaking changes');
            }
            if (map_unsafe && this.map_queries_mode !== MapQueriesMode.ALL) break;

            new_id = map_id;
            unsafe = unsafe || map_unsafe;
        }

        if (reject) {
            debugUpgradeQuery('Using persisted query %s for %s', new_id, id);
            if (unsafe) console.warn('[warn] Upgrading SplatNet 3 persisted query %s with potentially breaking changes', id);
        }

        return new_id;
    }

    /** * */
    async getCurrentFest() {
        return this.persistedQuery(RequestId.CurrentFestQuery, {});
    }

    /** * */
    async getConfigureAnalytics() {
        return this.persistedQuery(RequestId.ConfigureAnalyticsQuery, {});
    }

    /** / */
    async getHome() {
        return this.persistedQuery(RequestId.HomeQuery, {});
    }

    /** / -> /setting */
    async getSettings() {
        return this.persistedQuery(RequestId.SettingQuery, {});
    }

    /** / -> /photo_album */
    async getPhotoAlbum() {
        return this.persistedQuery(RequestId.PhotoAlbumQuery, {});
    }

    /** / -> /photo_album -> pull-to-refresh */
    async getPhotoAlbumRefetch() {
        return this.persistedQuery(RequestId.PhotoAlbumRefetchQuery, {});
    }

    /** / -> /catalog_record */
    async getCatalog() {
        return this.persistedQuery(RequestId.CatalogQuery, {});
    }

    /** / -> /catalog_record -> pull-to-refresh */
    async getCatalogRefetch() {
        return this.persistedQuery(RequestId.CatalogRefetchQuery, {});
    }

    /** / -> /checkin */
    async getCheckinHistory() {
        return this.persistedQuery(RequestId.CheckinQuery, {});
    }

    /** / -> /checkin */
    async checkin(id: string) {
        return this.persistedQuery(RequestId.CheckinWithQRCodeMutation, {
            checkinEventId: id,
        });
    }

    /** / -> /friends */
    async getFriends() {
        return this.persistedQuery(RequestId.FriendListQuery, {});
    }

    /** / -> /friends -> pull-to-refresh */
    async getFriendsRefetch() {
        return this.persistedQuery(RequestId.FriendListRefetchQuery, {});
    }

    /** / -> /hero_record */
    async getHeroRecords() {
        return this.persistedQuery(RequestId.HeroHistoryQuery, {});
    }

    /** / -> /hero_record -> pull-to-refresh */
    async getHeroRecordsRefetch() {
        return this.persistedQuery(RequestId.HeroHistoryRefetchQuery, {});
    }

    /** / -> /history_record */
    async getHistoryRecords() {
        return this.persistedQuery(RequestId.HistoryRecordQuery, {});
    }

    /** / -> /history_record -> pull-to-refresh */
    async getHistoryRecordsRefetch() {
        return this.persistedQuery(RequestId.HistoryRecordRefetchQuery, {});
    }

    /** / -> /schedule */
    async getSchedules() {
        return this.persistedQuery(RequestId.StageScheduleQuery, {});
    }

    /** / -> /stage_record */
    async getStageRecords() {
        return this.persistedQuery(RequestId.StageRecordQuery, {});
    }

    /** / -> /stage_record -> pull-to-refresh */
    async getStageRecordsRefetch() {
        return this.persistedQuery(RequestId.StageRecordsRefetchQuery, {});
    }

    /** / -> /weapon_record */
    async getWeaponRecords() {
        return this.persistedQuery(RequestId.WeaponRecordQuery, {});
    }

    /** / -> /weapon_record -> pull-to-refresh */
    async getWeaponRecordsRefetch() {
        return this.persistedQuery(RequestId.WeaponRecordsRefetchQuery, {});
    }

    //
    // Wandercrust
    //

    /** / -> /challenge */
    async getChallengeHome() {
        return this.persistedQuery(RequestId.ChallengeQuery, {});
    }

    /** / -> /challenge -> pull-to-refresh */
    async getChallengeHomeRefetch() {
        return this.persistedQuery(RequestId.ChallengeRefetchQuery, {});
    }

    /** / -> /challenge -> /challenge/{id} */
    async getChallengeJourney(id: string) {
        const result = await this.persistedQuery(RequestId.JourneyQuery, {
            id,
        });

        if (!result.data.journey) {
            throw new ErrorResponse('[splatnet3] Journey not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /challenge -> /challenge/{id} -> pull-to-refresh */
    async getChallengeJourneyRefetch(id: string) {
        const result = await this.persistedQuery(RequestId.JourneyRefetchQuery, {
            id,
        });

        if (!result.data.journey) {
            throw new ErrorResponse('[splatnet3] Journey not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /challenge -> /challenge/{id} -> /challenge/{id}/*s */
    async getChallengeJourneyChallenges(id: string) {
        const result = await this.persistedQuery(RequestId.JourneyChallengeDetailQuery, {
            journeyId: id,
        });

        if (!result.data.journey) {
            throw new ErrorResponse('[splatnet3] Journey not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /challenge -> /challenge/{id} -> /challenge/{id}/* -> pull-to-refresh */
    async getChallengeJourneyChallengesRefetch(id: string) {
        const result = await this.persistedQuery(RequestId.JourneyChallengeDetailRefetchQuery, {
            journeyId: id,
        });

        if (!result.data.journey) {
            throw new ErrorResponse('[splatnet3] Journey not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /challenge -> /challenge/{id} -> /challenge/{id}/* -> support */
    async supportChallenge(id: string) {
        return this.persistedQuery(RequestId.SupportButton_SupportChallengeMutation, {
            id,
        });
    }

    //
    // Splatfests
    //

    /** / -> /fest_record */
    async getFestRecords() {
        return this.persistedQuery(RequestId.FestRecordQuery, {});
    }

    /** / -> /fest_record -> pull-to-refresh */
    async getFestRecordsRefetch() {
        return this.persistedQuery(RequestId.FestRecordRefetchQuery, {});
    }

    /** / -> /fest_record/{id} */
    async getFestDetail(id: string) {
        const result = await this.persistedQuery(RequestId.DetailFestRecordDetailQuery, {
            festId: id,
        });

        if (!result.data.fest) {
            throw new ErrorResponse('[splatnet3] Fest not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /fest_record -> /fest_record/{id} -> pull-to-refresh */
    async getFestDetailRefetch(id: string) {
        const result = await this.persistedQuery(RequestId.DetailFestRefethQuery, {
            festId: id,
        });

        if (!result.data.fest) {
            throw new ErrorResponse('[splatnet3] Fest not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /fest_record -> /fest_record/{id} - not closed -> /fest_record/voting_status/{id} */
    async getFestVotingStatus(id: string) {
        const result = await this.persistedQuery(RequestId.DetailVotingStatusQuery, {
            festId: id,
        });

        if (!result.data.fest) {
            throw new ErrorResponse('[splatnet3] Fest not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /fest_record -> /fest_record/{id} - not closed -> /fest_record/voting_status/{id} -> pull-to-refresh */
    async getFestVotingStatusRefetch(id: string) {
        const result = await this.persistedQuery(RequestId.DetailFestVotingStatusRefethQuery, {
            festId: id,
        });

        if (!result.data.fest) {
            throw new ErrorResponse('[splatnet3] Fest not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /fest_record -> /fest_record/{id} - not closed -> /fest_record/voting_status/{id} - not voted in game */
    async updateFestPoll(id: string) {
        return this.persistedQuery(RequestId.VotesUpdateFestVoteMutation, {
            teamId: id,
        });
    }

    /** / -> /fest_record -> /fest_record/{id} - closed -> /fest_record/ranking/{id} */
    async getFestRanking(id: string) {
        const result = await this.persistedQuery(RequestId.DetailRankingQuery, {
            festId: id,
        });

        if (!result.data.fest) {
            throw new ErrorResponse('[splatnet3] Fest not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /**
     * / -> /fest_record -> /fest_record/* - closed -> /fest_record/ranking/* -> scroll down
     *
     * @param {string} id FestTeam ID
     */
    async getFestRankingPagination(id: string, cursor: string) {
        const result = await this.persistedQuery(RequestId.RankingHoldersFestTeamRankingHoldersPaginationQuery, {
            cursor,
            first: 25,
            id,
        });

        if (!result.data.node) {
            throw new ErrorResponse('[splatnet3] FestTeam not found', result[ResponseSymbol], result);
        }

        return result;
    }

    //
    // X Rankings
    //

    /** / -> /x_ranking */
    async getXRanking(region?: XRankingRegion | null) {
        return this.persistedQuery(RequestId.XRankingQuery, {
            region: region ?? undefined,
        });
    }

    /** / -> /x_ranking -> pull-to-refresh */
    async getXRankingRefetch(region?: XRankingRegion | null) {
        return this.persistedQuery(RequestId.XRankingQuery, {
            region: region ?? null,
        });
    }

    /** / -> /x_ranking/{id}/{rule} */
    async getXRankingDetail(id: string) {
        return this.persistedQuery(RequestId.XRankingQuery, {
            id,
        });
    }

    /** / -> /x_ranking/{id}/{rule} -> pull-to-refresh */
    async getXRankingDetailRefetch(id: string) {
        return this.persistedQuery(RequestId.XRankingRefetchQuery, {
            id,
            pageAr: 1,
            pageCl: 1,
            pageGl: 1,
            pageLf: 1,
        });
    }

    /** / -> /x_ranking/{id}/{rule} -> scroll down */
    async getXRankingDetailPagination<
        T extends XRankingLeaderboardType, R extends XRankingLeaderboardRule
    >(id: string, type: T, rule: R, cursor: string) {
        const query =
            type === XRankingLeaderboardType.X_RANKING ?
                rule === XRankingLeaderboardRule.SPLAT_ZONES ? RequestId.DetailTabViewXRankingArRefetchQuery :
                rule === XRankingLeaderboardRule.TOWER_CONTROL ? RequestId.DetailTabViewXRankingLfRefetchQuery :
                rule === XRankingLeaderboardRule.RAINMAKER ? RequestId.DetailTabViewXRankingGlRefetchQuery :
                rule === XRankingLeaderboardRule.CLAM_BLITZ ? RequestId.DetailTabViewXRankingClRefetchQuery :
                null :
            type === XRankingLeaderboardType.WEAPON ?
                rule === XRankingLeaderboardRule.SPLAT_ZONES ? RequestId.DetailTabViewWeaponTopsArRefetchQuery :
                rule === XRankingLeaderboardRule.TOWER_CONTROL ? RequestId.DetailTabViewWeaponTopsLfRefetchQuery :
                rule === XRankingLeaderboardRule.RAINMAKER ? RequestId.DetailTabViewWeaponTopsGlRefetchQuery :
                rule === XRankingLeaderboardRule.CLAM_BLITZ ? RequestId.DetailTabViewWeaponTopsClRefetchQuery :
                null :
            null;

        if (!query) throw new Error('Invalid leaderboard');

        return this.persistedQuery<{
            [XRankingLeaderboardType.X_RANKING]: {
                [XRankingLeaderboardRule.SPLAT_ZONES]: ResultTypes[RequestId.DetailTabViewXRankingArRefetchQuery];
                [XRankingLeaderboardRule.TOWER_CONTROL]: ResultTypes[RequestId.DetailTabViewXRankingLfRefetchQuery];
                [XRankingLeaderboardRule.RAINMAKER]: ResultTypes[RequestId.DetailTabViewXRankingGlRefetchQuery];
                [XRankingLeaderboardRule.CLAM_BLITZ]: ResultTypes[RequestId.DetailTabViewXRankingClRefetchQuery];
            };
            [XRankingLeaderboardType.WEAPON]: {
                [XRankingLeaderboardRule.SPLAT_ZONES]: ResultTypes[RequestId.DetailTabViewWeaponTopsArRefetchQuery];
                [XRankingLeaderboardRule.TOWER_CONTROL]: ResultTypes[RequestId.DetailTabViewWeaponTopsLfRefetchQuery];
                [XRankingLeaderboardRule.RAINMAKER]: ResultTypes[RequestId.DetailTabViewWeaponTopsGlRefetchQuery];
                [XRankingLeaderboardRule.CLAM_BLITZ]: ResultTypes[RequestId.DetailTabViewWeaponTopsClRefetchQuery];
            };
        }[T][R]>(query, {
            cursor,
            first: 25,
            id,
            page: 1,
        });
    }

    //
    // SplatNet Shop
    //

    /** / -> /gesotown */
    async getSaleGear() {
        return this.persistedQuery(RequestId.GesotownQuery, {});
    }

    /** / -> /gesotown -> pull-to-refresh */
    async getSaleGearRefetch() {
        return this.persistedQuery(RequestId.GesotownRefetchQuery, {});
    }

    /** / -> /gesotown -> /gesotown/{id} */
    async getSaleGearDetail(id: string) {
        const result = await this.persistedQuery(RequestId.SaleGearDetailQuery, {
            saleGearId: id,
        });

        if (!result.data.saleGear) {
            throw new ErrorResponse('[splatnet3] Sale gear not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /gesotown -> /gesotown/{id} -> order */
    async orderSaleGear(id: string, force = false) {
        return this.persistedQuery(RequestId.SaleGearDetailOrderGesotownGearMutation, {
            input: {
                id,
                isForceOrder: force,
            },
        });
    }

    //
    // Freshest Fits/my outfits
    //

    /** / -> /my_outfits */
    async getMyOutfits() {
        return this.persistedQuery(RequestId.MyOutfitsQuery, {});
    }

    /** / -> /my_outfits -> pull-to-refresh */
    async getMyOutfitsRefetch() {
        return this.persistedQuery(RequestId.MyOutfitsRefetchQuery, {});
    }

    /** / -> /my_outfits -> /my_outfits/{id} */
    async getMyOutfitDetail(id: string) {
        const result = await this.persistedQuery(RequestId.MyOutfitDetailQuery, {
            myOutfitId: id,
        });

        if (!result.data.myOutfit) {
            throw new ErrorResponse('[splatnet3] My outfit not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /my_outfits -> /my_outfits/{id / create} */
    async getEquipmentFilters() {
        return this.persistedQuery(RequestId.MyOutfitCommonDataFilteringConditionQuery, {});
    }

    /** / -> /my_outfits -> /my_outfits/{id / create} */
    async getEquipment() {
        return this.persistedQuery(RequestId.MyOutfitCommonDataEquipmentsQuery, {});
    }

    /** / -> /my_outfits -> /my_outfits/{id / create} */
    async createOutfit(data: MyOutfitInput) {
        return this.persistedQuery(RequestId.CreateMyOutfitMutation, {
            input: {
                myOutfit: data,
            },
            connections: [
                'client:root:__connection_myOutfits_connection',
            ],
        });
    }

    /** / -> /my_outfits -> /my_outfits/{id / create} */
    async updateOutfit(id: string, data: MyOutfitInput) {
        return this.persistedQuery(RequestId.UpdateMyOutfitMutation, {
            input: {
                myOutfit: {
                    id,
                    ...data,
                },
            },
        });
    }

    //
    // Replays
    //

    /** / -> /replay */
    async getReplays() {
        return this.persistedQuery(RequestId.ReplayQuery, {});
    }

    /** / -> /replay -> pull-to-refetch */
    async getReplaysRefetch() {
        return this.persistedQuery(RequestId.ReplayUploadedReplayListRefetchQuery, {});
    }

    /** / -> /replay -> enter code */
    async getReplaySearchResult(code: string) {
        if (!REPLAY_CODE_REGEX.test(code)) throw new Error('Invalid replay code');

        const result = await this.persistedQuery(RequestId.DownloadSearchReplayQuery, {
            code,
        });

        if (!result.data.replay) {
            throw new ErrorResponse('[splatnet3] Replay not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /replay -> enter code -> download */
    async reserveReplayDownload(id: string) {
        return this.persistedQuery(RequestId.ReplayModalReserveReplayDownloadMutation, {
            input: {
                id,
            },
        });
    }

    //
    // Battle history
    //

    /** / -> /history */
    async getBattleHistoryCurrentPlayer() {
        return this.persistedQuery(RequestId.BattleHistoryCurrentPlayerQuery, {});
    }

    /** / -> /history */
    async getLatestBattleHistories() {
        return this.persistedQuery(RequestId.LatestBattleHistoriesQuery, {});
    }

    /** / -> /history -> /history/latest -> pull-to-refresh */
    async getLatestBattleHistoriesRefetch() {
        return this.persistedQuery<
            LatestBattleHistoriesRefetchResult<true>, LatestBattleHistoriesRefetchVariables
        >(RequestId.LatestBattleHistoriesRefetchQuery, {
            fetchCurrentPlayer: true,
        });
    }

    /** / -> /history */
    async getRegularBattleHistories() {
        return this.persistedQuery(RequestId.RegularBattleHistoriesQuery, {});
    }

    /** / -> /history -> /history/regular -> pull-to-refresh */
    async getRegularBattleHistoriesRefetch() {
        return this.persistedQuery<
            RegularBattleHistoriesRefetchResult<true>, RegularBattleHistoriesRefetchVariables
        >(RequestId.RegularBattleHistoriesRefetchQuery, {
            fetchCurrentPlayer: true,
        });
    }

    /** / -> /history */
    async getBankaraBattleHistories() {
        return this.persistedQuery(RequestId.BankaraBattleHistoriesQuery, {});
    }

    /** / -> /history -> /history/bankara -> pull-to-refresh */
    async getBankaraBattleHistoriesRefetch() {
        return this.persistedQuery<
            BankaraBattleHistoriesRefetchResult<true>, BankaraBattleHistoriesRefetchVariables
        >(RequestId.BankaraBattleHistoriesRefetchQuery, {
            fetchCurrentPlayer: true,
        });
    }

    /** / -> /history */
    async getXBattleHistories() {
        return this.persistedQuery(RequestId.XBattleHistoriesQuery, {});
    }

    /** / -> /history -> /history/xmatch -> pull-to-refresh */
    async getXBattleHistoriesRefetch() {
        return this.persistedQuery<
            XBattleHistoriesRefetchResult<true>, XBattleHistoriesRefetchVariables
        >(RequestId.XBattleHistoriesRefetchQuery, {
            fetchCurrentPlayer: true,
        });
    }

    /** / -> /history */
    async getPrivateBattleHistories() {
        return this.persistedQuery(RequestId.PrivateBattleHistoriesQuery, {});
    }

    /** / -> /history -> /history/private -> pull-to-refresh */
    async getPrivateBattleHistoriesRefetch() {
        return this.persistedQuery<
            PrivateBattleHistoriesRefetchResult<true>, PrivateBattleHistoriesRefetchVariables
        >(RequestId.PrivateBattleHistoriesRefetchQuery, {
            fetchCurrentPlayer: true,
        });
    }

    /** / -> /history -> /history/detail/{id} */
    async getBattleHistoryDetail(id: string) {
        const result = await this.persistedQuery(RequestId.VsHistoryDetailQuery, {
            vsResultId: id,
        });

        if (!result.data.vsHistoryDetail) {
            throw new ErrorResponse('[splatnet3] Battle history not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /history -> /history/detail/{id} -> pull-to-refresh */
    async getBattleHistoryDetailPagerRefetch(id: string) {
        const result = await this.persistedQuery(RequestId.VsHistoryDetailPagerRefetchQuery, {
            vsResultId: id,
        });

        if (!result.data.vsHistoryDetail) {
            throw new ErrorResponse('[splatnet3] Battle history not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /history -> /history/detail/* -> latest */
    async getBattleHistoryLatest() {
        return this.persistedQuery(RequestId.PagerLatestVsDetailQuery, {});
    }

    /** / -> /history -> /history/detail/* -> latest */
    async getBattleHistoryPagerUpdateByVsMode() {
        return this.persistedQuery<
            PagerUpdateBattleHistoriesByVsModeResult<false, false, false, false, false>,
            PagerUpdateBattleHistoriesByVsModeVariables
        >(RequestId.PagerUpdateBattleHistoriesByVsModeQuery, {
            isBankara: false,
            isLeague: false,
            isPrivate: false,
            isRegular: false,
            isXBattle: false,
        });
    }

    //
    // Salmon Run
    //

    /** / -> /coop */
    async getCoopHistory() {
        return this.persistedQuery(RequestId.CoopHistoryQuery, {});
    }

    /** / -> /coop */
    async getCoopHistoryRefetch() {
        return this.persistedQuery(RequestId.RefetchableCoopHistory_CoopResultQuery, {});
    }

    /** / -> /coop -> /coop/{id} */
    async getCoopHistoryDetail(id: string) {
        const result = await this.persistedQuery(RequestId.CoopHistoryDetailQuery, {
            coopHistoryDetailId: id,
        });

        if (!result.data.coopHistoryDetail) {
            throw new ErrorResponse('[splatnet3] Co-op history not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /coop -> /coop/{id} -> pull-to-refresh */
    async getCoopHistoryDetailRefetch(id: string) {
        const result = await this.persistedQuery(RequestId.CoopHistoryDetailRefetchQuery, {
            id,
        });

        if (!result.data.node) {
            throw new ErrorResponse('[splatnet3] Co-op history not found', result[ResponseSymbol], result);
        }

        return result;
    }

    /** / -> /coop -> /coop/* -> latest */
    async getCoopHistoryLatest() {
        return this.persistedQuery(RequestId.CoopPagerLatestCoopQuery, {});
    }

    //
    //

    async renewTokenWithCoral(nso: CoralApi, user: NintendoAccountUser) {
        const data = await SplatNet3Api.loginWithCoral(nso, user);
        this.setTokenWithSavedToken(data);
        return data;
    }

    async renewTokenWithWebServiceToken(webserviceToken: WebServiceToken, user: NintendoAccountUser) {
        const data = await SplatNet3Api.loginWithWebServiceToken(webserviceToken, user);
        this.setTokenWithSavedToken(data);
        return data;
    }

    protected setTokenWithSavedToken(data: SplatNet3AuthData) {
        this.bullet_token = data.bullet_token.bulletToken;
        this.version = data.version;
        this.language = data.bullet_token.lang;
        this.useragent = data.useragent;
    }

    static async createWithCoral(nso: CoralApi, user: NintendoAccountUser) {
        const data = await this.loginWithCoral(nso, user);
        return {splatnet: this.createWithSavedToken(data), data};
    }

    static createWithSavedToken(data: SplatNet3AuthData) {
        return new this(
            data.bullet_token.bulletToken,
            data.version,
            {},
            getMapPersistedQueriesModeFromEnvironment(),
            data.bullet_token.lang,
            data.useragent,
        );
    }

    static createWithCliTokenData(data: SplatNet3CliTokenData) {
        return new this(
            data.bullet_token,
            data.version,
            {},
            getMapPersistedQueriesModeFromEnvironment(),
            data.language,
            SPLATNET3_WEBSERVICE_USERAGENT,
        );
    }

    static async loginWithCoral(nso: CoralApi, user: NintendoAccountUser) {
        const { default: { coral_gws_splatnet3: config } } = await import('../common/remote-config.js');
        if (!config) throw new Error('Remote configuration prevents SplatNet 3 authentication');

        const webserviceToken = await nso.getWebServiceToken(SPLATNET3_WEBSERVICE_ID);

        return this.loginWithWebServiceToken(webserviceToken, user);
    }

    static async loginWithWebServiceToken(
        webserviceToken: WebServiceToken, user: NintendoAccountUser
    ): Promise<SplatNet3AuthData> {
        const { default: { coral_gws_splatnet3: config } } = await import('../common/remote-config.js');
        if (!config) throw new Error('Remote configuration prevents SplatNet 3 authentication');

        const language = languages.includes(user.language) ? user.language : 'en-GB';
        const version = config.app_ver ?? config.version + '-' + config.revision.substr(0, 8);

        const url = new URL(SPLATNET3_WEBSERVICE_URL);
        url.search = new URLSearchParams({
            lang: user.language,
            na_country: user.country,
            na_lang: user.language,
        }).toString();

        const [signal, cancel] = timeoutSignal();
        const response = await fetch(url.toString(), {
            headers: {
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': SPLATNET3_WEBSERVICE_USERAGENT,
                'x-appcolorscheme': 'DARK',
                'x-gamewebtoken': webserviceToken.accessToken,
                'dnt': '1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-GB,en-US;q=0.8',
                'X-Requested-With': 'com.nintendo.znca',
            },
            signal,
        }).finally(cancel);

        debug('fetch %s %s, response %s', 'GET', url, response.status);

        const body = await response.text();

        if (response.status !== 200) {
            throw new ErrorResponse('[splatnet3] Non-200 status code', response, body);
        }

        const cookies = response.headers.get('Set-Cookie');

        const [signal2, cancel2] = timeoutSignal();
        const tr = await fetch(SPLATNET3_URL + '/bullet_tokens', {
            method: 'POST',
            headers: {
                'User-Agent': SPLATNET3_WEBSERVICE_USERAGENT,
                'Accept': '*/*',
                'Referrer': 'https://api.lp1.av5ja.srv.nintendo.net/',
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/json',
                'X-Web-View-Ver': version,
                'X-NACOUNTRY': user.country,
                'Accept-Language': language,
                'X-GameWebToken': webserviceToken.accessToken,
            },
            body: '',
            signal: signal2,
        }).finally(cancel2);

        debug('fetch %s %s, response %s', 'POST', '/bullet_tokens', response.status);

        const error: string | undefined = AUTH_ERROR_CODES[tr.status as keyof typeof AUTH_ERROR_CODES];
        if (error) throw new ErrorResponse('[splatnet3] ' + error, tr, await tr.text());
        if (tr.status !== 201) throw new ErrorResponse('[splatnet3] Non-201 status code', tr, await tr.text());

        const bullet_token = await tr.json() as BulletToken;
        const created_at = Date.now();
        const expires_at = created_at + TOKEN_EXPIRES_IN;

        return {
            webserviceToken,
            url: url.toString(),
            cookies,
            body,

            language,
            country: user.country,
            version,

            bullet_token,
            created_at,
            expires_at,
            useragent: SPLATNET3_WEBSERVICE_USERAGENT,
        };
    }
}

function getMapPersistedQueriesModeFromEnvironment(): MapQueriesMode {
    if (process.env.NXAPI_SPLATNET3_UPGRADE_QUERIES === '0') return MapQueriesMode.NEVER;
    if (process.env.NXAPI_SPLATNET3_UPGRADE_QUERIES === '1') return MapQueriesMode.ONLY_SAFE_NO_REJECT;
    if (process.env.NXAPI_SPLATNET3_UPGRADE_QUERIES === '2') return MapQueriesMode.ONLY_SAFE;
    if (process.env.NXAPI_SPLATNET3_UPGRADE_QUERIES === '3') return MapQueriesMode.ALL;

    return MapQueriesMode.ALL;
}

export interface SplatNet3AuthData {
    webserviceToken: WebServiceToken;
    url: string;
    cookies: string | null;
    body: string;

    language: string;
    country: string;
    version: string;

    bullet_token: BulletToken;
    created_at: number;
    /**
     * /api/bullet_tokens does not provide the token validity duration. Instead this assumes
     * the token is valid for 2 hours. GraphQL responses include the actual remaining time
     * in the x-bullettoken-remaining header.
     */
    expires_at: number;
    useragent: string;
}

export interface SplatNet3CliTokenData {
    bullet_token: string;
    expires_at: number;
    language: string;
    version: string;
}

export enum XRankingRegion {
    /** Takoroka division */
    PACIFIC = 'PACIFIC',
    /** Tentatek division */
    ATLANTIC = 'ATLANTIC',
}

export enum XRankingLeaderboardType {
    X_RANKING,
    WEAPON,
}

export enum XRankingLeaderboardRule {
    SPLAT_ZONES,
    TOWER_CONTROL,
    RAINMAKER,
    CLAM_BLITZ,
}
