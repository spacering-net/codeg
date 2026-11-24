//! Axum handlers mirroring `commands::background`. All of them are stateless
//! (disk-only or proxied fetch), so none take `Extension<Arc<AppState>>`.

use axum::Json;

use crate::app_error::AppCommandError;
use crate::backgrounds::marketplace::{MarketSearchPage, MarketSearchParams};
use crate::commands::background as background_commands;
use crate::commands::background::BackgroundSetParams;
use crate::commands::background::{
    BackgroundMarketAssetParams, BackgroundMarketDownloadParams, BackgroundMarketSearchParams,
};
use crate::models::background::BackgroundAsset;

pub async fn background_read() -> Result<Json<Option<BackgroundAsset>>, AppCommandError> {
    background_commands::background_read_core().await.map(Json)
}

pub async fn background_set(
    Json(params): Json<BackgroundSetParams>,
) -> Result<Json<()>, AppCommandError> {
    background_commands::background_set_core(params.image_base64)
        .await
        .map(Json)
}

pub async fn background_clear() -> Result<Json<()>, AppCommandError> {
    background_commands::background_clear_core().await.map(Json)
}

pub async fn background_market_search(
    Json(params): Json<BackgroundMarketSearchParams>,
) -> Result<Json<MarketSearchPage>, AppCommandError> {
    background_commands::background_market_search_core(MarketSearchParams {
        query: params.query,
        category: params.category,
        page: params.page,
    })
    .await
    .map(Json)
}

pub async fn background_market_asset(
    Json(params): Json<BackgroundMarketAssetParams>,
) -> Result<Json<BackgroundAsset>, AppCommandError> {
    background_commands::background_market_asset_core(params.url)
        .await
        .map(Json)
}

pub async fn background_market_download(
    Json(params): Json<BackgroundMarketDownloadParams>,
) -> Result<Json<()>, AppCommandError> {
    background_commands::background_market_download_core(params.url, params.source_url)
        .await
        .map(Json)
}
