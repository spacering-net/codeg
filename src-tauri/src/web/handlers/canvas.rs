use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::canvas as canvas_commands;
use crate::commands::canvas::{
    CanvasNodeMovePayload, CanvasNodePatchInput, CreateCanvasNode, GroupIntoRegionInput,
    GroupIntoRegionResult,
};
use crate::models::canvas::{CanvasMutation, CanvasNode, CanvasSnapshot};

pub async fn canvas_list_nodes(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CanvasSnapshot>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_list_nodes_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
pub struct CreateParams {
    pub input: CreateCanvasNode,
}

pub async fn canvas_create_node(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateParams>,
) -> Result<Json<CanvasMutation<CanvasNode>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_create_node_core(&state.emitter, &state.db, params.input).await?,
    ))
}

#[derive(Deserialize)]
pub struct GroupIntoRegionParams {
    pub input: GroupIntoRegionInput,
}

pub async fn canvas_group_into_region(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GroupIntoRegionParams>,
) -> Result<Json<CanvasMutation<GroupIntoRegionResult>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_group_into_region_core(&state.emitter, &state.db, params.input)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    pub node_id: i32,
    pub patch: CanvasNodePatchInput,
}

pub async fn canvas_update_node(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateParams>,
) -> Result<Json<CanvasMutation<CanvasNode>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_update_node_core(
            &state.emitter,
            &state.db,
            params.node_id,
            params.patch,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct MoveParams {
    pub moves: Vec<CanvasNodeMovePayload>,
}

pub async fn canvas_move_nodes(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MoveParams>,
) -> Result<Json<CanvasMutation<Vec<CanvasNodeMovePayload>>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_move_nodes_core(&state.emitter, &state.db, params.moves).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachParams {
    pub region_id: i32,
    pub conversation_id: i32,
    pub x: f64,
    pub y: f64,
}

pub async fn canvas_detach_member(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DetachParams>,
) -> Result<Json<CanvasMutation<CanvasNode>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_detach_member_core(
            &state.emitter,
            &state.db,
            params.region_id,
            params.conversation_id,
            params.x,
            params.y,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteParams {
    pub node_id: i32,
}

pub async fn canvas_delete_node(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeleteParams>,
) -> Result<Json<CanvasMutation<()>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_delete_node_core(
            &state.emitter,
            &state.db,
            &state.terminal_manager,
            params.node_id,
        )
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteManyParams {
    pub node_ids: Vec<i32>,
}

pub async fn canvas_delete_nodes(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeleteManyParams>,
) -> Result<Json<CanvasMutation<Vec<i32>>>, AppCommandError> {
    Ok(Json(
        canvas_commands::canvas_delete_nodes_core(
            &state.emitter,
            &state.db,
            &state.terminal_manager,
            params.node_ids,
        )
            .await?,
    ))
}
