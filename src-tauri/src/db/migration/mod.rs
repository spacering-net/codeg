use sea_orm_migration::prelude::*;

mod m20260211_000001_init;
mod m20260219_000001_folder_command;
mod m20260221_000001_folder_is_open;
mod m20260226_000001_agent_setting;
mod m20260227_000001_folder_parent_branch;
mod m20260330_000001_chat_channel;
mod m20260401_000001_chat_channel_sender_context;
mod m20260404_000001_model_provider;
mod m20260406_000001_agent_setting_model_provider;
mod m20260420_000001_opened_tabs;
mod m20260422_000001_folder_sort_order;
mod m20260423_000001_drop_folder_parent_branch;
mod m20260424_000001_folder_color;
mod m20260424_000002_quick_message;
mod m20260513_000001_remote_workspace_connection;
mod m20260518_000001_model_provider_single_type_and_model;
mod m20260522_000001_delegation_columns;
mod m20260607_000001_folder_parent_id;
mod m20260608_000001_conversation_title_locked;
mod m20260610_000001_conversation_pinned_at;
mod m20260611_000001_folder_is_chat;
mod m20260612_000001_conversation_folder_kind;
mod m20260621_000001_automation;
mod m20260630_000001_conversation_parent_id_index;
mod m20260703_000001_chat_channel_thread_binding;
mod m20260717_000001_folder_alias;
mod m20260726_000001_custom_agent;
mod m20260727_000001_custom_agent_skills;
mod m20260728_000001_custom_agent_skills_dir;
mod m20260728_000002_custom_agent_source;
mod m20260801_000001_work_task;
mod m20260801_000002_work_task_p2;
mod m20260801_000003_work_task_template;
mod m20260803_000001_folder_link;
mod m20260803_000001_token_usage;
mod m20260807_000001_work_task_scheduled_at;
mod m20260808_000001_custom_agent_supports_mcp;
mod m20260817_000001_work_task_conversation_title;
mod m20260818_000001_work_task_source;
mod m20260819_000001_work_task_completion_kind;
mod m20260825_000001_remote_workspace_connection_headers;
mod m20260829_000001_folder_group;
mod m20260830_000001_canvas_node;
mod m20260831_000001_canvas_node_group_grid;
mod m20260907_000001_canvas_node_path;
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260211_000001_init::Migration),
            Box::new(m20260219_000001_folder_command::Migration),
            Box::new(m20260221_000001_folder_is_open::Migration),
            Box::new(m20260226_000001_agent_setting::Migration),
            Box::new(m20260227_000001_folder_parent_branch::Migration),
            Box::new(m20260330_000001_chat_channel::Migration),
            Box::new(m20260401_000001_chat_channel_sender_context::Migration),
            Box::new(m20260404_000001_model_provider::Migration),
            Box::new(m20260406_000001_agent_setting_model_provider::Migration),
            Box::new(m20260420_000001_opened_tabs::Migration),
            Box::new(m20260422_000001_folder_sort_order::Migration),
            Box::new(m20260423_000001_drop_folder_parent_branch::Migration),
            Box::new(m20260424_000001_folder_color::Migration),
            Box::new(m20260424_000002_quick_message::Migration),
            Box::new(m20260513_000001_remote_workspace_connection::Migration),
            Box::new(m20260518_000001_model_provider_single_type_and_model::Migration),
            Box::new(m20260522_000001_delegation_columns::Migration),
            Box::new(m20260607_000001_folder_parent_id::Migration),
            Box::new(m20260608_000001_conversation_title_locked::Migration),
            Box::new(m20260610_000001_conversation_pinned_at::Migration),
            Box::new(m20260611_000001_folder_is_chat::Migration),
            Box::new(m20260612_000001_conversation_folder_kind::Migration),
            Box::new(m20260621_000001_automation::Migration),
            Box::new(m20260630_000001_conversation_parent_id_index::Migration),
            Box::new(m20260703_000001_chat_channel_thread_binding::Migration),
            Box::new(m20260717_000001_folder_alias::Migration),
            Box::new(m20260726_000001_custom_agent::Migration),
            Box::new(m20260727_000001_custom_agent_skills::Migration),
            Box::new(m20260728_000001_custom_agent_skills_dir::Migration),
            Box::new(m20260728_000002_custom_agent_source::Migration),
            Box::new(m20260801_000001_work_task::Migration),
            Box::new(m20260801_000002_work_task_p2::Migration),
            Box::new(m20260801_000003_work_task_template::Migration),
            Box::new(m20260803_000001_folder_link::Migration),
            Box::new(m20260803_000001_token_usage::Migration),
            Box::new(m20260807_000001_work_task_scheduled_at::Migration),
            Box::new(m20260808_000001_custom_agent_supports_mcp::Migration),
            Box::new(m20260817_000001_work_task_conversation_title::Migration),
            Box::new(m20260818_000001_work_task_source::Migration),
            Box::new(m20260819_000001_work_task_completion_kind::Migration),
            Box::new(m20260825_000001_remote_workspace_connection_headers::Migration),
            Box::new(m20260829_000001_folder_group::Migration),
            Box::new(m20260830_000001_canvas_node::Migration),
            Box::new(m20260831_000001_canvas_node_group_grid::Migration),
            Box::new(m20260907_000001_canvas_node_path::Migration),
        ]
    }
}
