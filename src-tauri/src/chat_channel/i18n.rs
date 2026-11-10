use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lang {
    #[default]
    En,
    ZhCn,
    ZhTw,
    Ja,
    Ko,
    Es,
    De,
    Fr,
    Pt,
    Ar,
}

impl Lang {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "en" => Lang::En,
            "zh-cn" | "zh-CN" | "zh_CN" => Lang::ZhCn,
            "zh-tw" | "zh-TW" | "zh_TW" => Lang::ZhTw,
            "ja" => Lang::Ja,
            "ko" => Lang::Ko,
            "es" => Lang::Es,
            "de" => Lang::De,
            "fr" => Lang::Fr,
            "pt" => Lang::Pt,
            "ar" => Lang::Ar,
            _ => Lang::En,
        }
    }
}

// ── Event messages ──

pub fn turn_complete_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "会话完成",
        Lang::ZhTw => "對話完成",
        Lang::Ja => "セッション完了",
        Lang::Ko => "세션 완료",
        Lang::Es => "Sesión completada",
        Lang::De => "Sitzung abgeschlossen",
        Lang::Fr => "Session terminée",
        Lang::Pt => "Sessão concluída",
        Lang::Ar => "اكتملت الجلسة",
        Lang::En => "Turn Complete",
    }
}

pub fn turn_complete_body(lang: Lang, agent_type: &str) -> String {
    match lang {
        Lang::ZhCn => format!("{agent_type} 会话已完成"),
        Lang::ZhTw => format!("{agent_type} 對話已完成"),
        Lang::Ja => format!("{agent_type} セッションが完了しました"),
        Lang::Ko => format!("{agent_type} 세션이 완료되었습니다"),
        Lang::Es => format!("{agent_type} sesión completada"),
        Lang::De => format!("{agent_type} Sitzung abgeschlossen"),
        Lang::Fr => format!("Session {agent_type} terminée"),
        Lang::Pt => format!("Sessão {agent_type} concluída"),
        Lang::Ar => format!("اكتملت جلسة {agent_type}"),
        Lang::En => format!("{agent_type} session completed"),
    }
}

pub fn stop_reason_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "结束原因",
        Lang::ZhTw => "結束原因",
        Lang::Ja => "終了理由",
        Lang::Ko => "종료 사유",
        Lang::Es => "Motivo de fin",
        Lang::De => "Beendigungsgrund",
        Lang::Fr => "Raison de fin",
        Lang::Pt => "Motivo do término",
        Lang::Ar => "سبب الانتهاء",
        Lang::En => "Stop Reason",
    }
}

pub fn stop_reason_end_turn(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "正常结束",
        Lang::ZhTw => "正常結束",
        Lang::Ja => "正常終了",
        Lang::Ko => "정상 종료",
        Lang::Es => "Finalizado",
        Lang::De => "Normal beendet",
        Lang::Fr => "Terminé normalement",
        Lang::Pt => "Finalizado",
        Lang::Ar => "انتهى بشكل طبيعي",
        Lang::En => "Completed",
    }
}

pub fn stop_reason_cancelled(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已取消",
        Lang::ZhTw => "已取消",
        Lang::Ja => "キャンセル",
        Lang::Ko => "취소됨",
        Lang::Es => "Cancelado",
        Lang::De => "Abgebrochen",
        Lang::Fr => "Annulé",
        Lang::Pt => "Cancelado",
        Lang::Ar => "تم الإلغاء",
        Lang::En => "Cancelled",
    }
}

pub fn agent_error_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "代理错误",
        Lang::ZhTw => "代理錯誤",
        Lang::Ja => "エージェントエラー",
        Lang::Ko => "에이전트 오류",
        Lang::Es => "Error del agente",
        Lang::De => "Agent-Fehler",
        Lang::Fr => "Erreur de l'agent",
        Lang::Pt => "Erro do agente",
        Lang::Ar => "خطأ في الوكيل",
        Lang::En => "Agent Error",
    }
}

pub fn agent_error_body(lang: Lang, agent_type: &str) -> String {
    match lang {
        Lang::ZhCn => format!("{agent_type} 发生错误"),
        Lang::ZhTw => format!("{agent_type} 發生錯誤"),
        Lang::Ja => format!("{agent_type} でエラーが発生しました"),
        Lang::Ko => format!("{agent_type}에서 오류 발생"),
        Lang::Es => format!("{agent_type} encontró un error"),
        Lang::De => format!("{agent_type} hat einen Fehler"),
        Lang::Fr => format!("{agent_type} a rencontré une erreur"),
        Lang::Pt => format!("{agent_type} encontrou um erro"),
        Lang::Ar => format!("حدث خطأ في {agent_type}"),
        Lang::En => format!("{agent_type} encountered an error"),
    }
}

pub fn error_message_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "错误信息",
        Lang::ZhTw => "錯誤訊息",
        Lang::Ja => "エラーメッセージ",
        Lang::Ko => "오류 메시지",
        Lang::Es => "Mensaje de error",
        Lang::De => "Fehlermeldung",
        Lang::Fr => "Message d'erreur",
        Lang::Pt => "Mensagem de erro",
        Lang::Ar => "رسالة الخطأ",
        Lang::En => "Error Message",
    }
}

// ── Permission request (global event push) ──

pub fn permission_request_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "权限请求",
        Lang::ZhTw => "權限請求",
        Lang::Ja => "権限リクエスト",
        Lang::Ko => "권한 요청",
        Lang::Es => "Solicitud de permiso",
        Lang::De => "Berechtigungsanfrage",
        Lang::Fr => "Demande d'autorisation",
        Lang::Pt => "Solicitação de permissão",
        Lang::Ar => "طلب إذن",
        Lang::En => "Permission Request",
    }
}

pub fn permission_request_body(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "智能体正在请求权限，请在 Codeg 中查看并批准。",
        Lang::ZhTw => "智慧代理正在請求權限，請在 Codeg 中查看並批准。",
        Lang::Ja => "エージェントが権限を要求しています。Codeg で確認して承認してください。",
        Lang::Ko => "에이전트가 권한을 요청하고 있습니다. Codeg에서 확인하고 승인하세요.",
        Lang::Es => "Un agente solicita permiso. Revísalo y apruébalo en Codeg.",
        Lang::De => "Ein Agent fordert eine Berechtigung an. Bitte in Codeg prüfen und genehmigen.",
        Lang::Fr => "Un agent demande une autorisation. Vérifiez-la et approuvez-la dans Codeg.",
        Lang::Pt => "Um agente está solicitando permissão. Revise e aprove no Codeg.",
        Lang::Ar => "يطلب أحد الوكلاء إذنًا. يرجى مراجعته والموافقة عليه في Codeg.",
        Lang::En => "An agent is requesting permission. Review and approve it in Codeg.",
    }
}

pub fn permission_operation_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "请求操作",
        Lang::ZhTw => "請求操作",
        Lang::Ja => "要求された操作",
        Lang::Ko => "요청된 작업",
        Lang::Es => "Operación solicitada",
        Lang::De => "Angeforderte Aktion",
        Lang::Fr => "Opération demandée",
        Lang::Pt => "Operação solicitada",
        Lang::Ar => "العملية المطلوبة",
        Lang::En => "Requested operation",
    }
}

// ── User message (global event push) ──

pub fn user_message_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "用户消息",
        Lang::ZhTw => "使用者訊息",
        Lang::Ja => "ユーザーメッセージ",
        Lang::Ko => "사용자 메시지",
        Lang::Es => "Mensaje del usuario",
        Lang::De => "Benutzernachricht",
        Lang::Fr => "Message de l'utilisateur",
        Lang::Pt => "Mensagem do usuário",
        Lang::Ar => "رسالة المستخدم",
        Lang::En => "User Message",
    }
}

// ── Agent question (global event push) ──

pub fn question_request_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "智能体提问",
        Lang::ZhTw => "智慧代理提問",
        Lang::Ja => "エージェントからの質問",
        Lang::Ko => "에이전트 질문",
        Lang::Es => "Pregunta del agente",
        Lang::De => "Frage des Agenten",
        Lang::Fr => "Question de l'agent",
        Lang::Pt => "Pergunta do agente",
        Lang::Ar => "سؤال من الوكيل",
        Lang::En => "Agent Question",
    }
}

pub fn question_request_body(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "智能体正在向你提问，请在 Codeg 中回答。",
        Lang::ZhTw => "智慧代理正在向你提問，請在 Codeg 中回答。",
        Lang::Ja => "エージェントが質問しています。Codeg で回答してください。",
        Lang::Ko => "에이전트가 질문하고 있습니다. Codeg에서 답변하세요.",
        Lang::Es => "Un agente te hace una pregunta. Respóndela en Codeg.",
        Lang::De => "Ein Agent stellt eine Frage. Bitte in Codeg beantworten.",
        Lang::Fr => "Un agent vous pose une question. Répondez-y dans Codeg.",
        Lang::Pt => "Um agente está fazendo uma pergunta. Responda no Codeg.",
        Lang::Ar => "يطرح أحد الوكلاء سؤالاً. يرجى الإجابة عليه في Codeg.",
        Lang::En => "An agent is asking a question. Answer it in Codeg.",
    }
}

/// Field-label fallback for a question whose `header` chip is empty.
pub fn question_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "问题",
        Lang::ZhTw => "問題",
        Lang::Ja => "質問",
        Lang::Ko => "질문",
        Lang::Es => "Pregunta",
        Lang::De => "Frage",
        Lang::Fr => "Question",
        Lang::Pt => "Pergunta",
        Lang::Ar => "سؤال",
        Lang::En => "Question",
    }
}

// ── Daily report ──

pub fn daily_report_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "每日编码报告",
        Lang::ZhTw => "每日編碼報告",
        Lang::Ja => "日次コーディングレポート",
        Lang::Ko => "일일 코딩 보고서",
        Lang::Es => "Informe diario de codificación",
        Lang::De => "Täglicher Coding-Bericht",
        Lang::Fr => "Rapport de codage quotidien",
        Lang::Pt => "Relatório diário de codificação",
        Lang::Ar => "تقرير البرمجة اليومي",
        Lang::En => "Daily Coding Report",
    }
}

pub fn daily_report_summary(lang: Lang, date: &str) -> String {
    match lang {
        Lang::ZhCn => format!("今日编码活动汇总 ({date})"),
        Lang::ZhTw => format!("今日編碼活動匯總 ({date})"),
        Lang::Ja => format!("本日のコーディング活動まとめ ({date})"),
        Lang::Ko => format!("오늘의 코딩 활동 요약 ({date})"),
        Lang::Es => format!("Resumen de actividad de codificación ({date})"),
        Lang::De => format!("Coding-Aktivitätszusammenfassung ({date})"),
        Lang::Fr => format!("Résumé de l'activité de codage ({date})"),
        Lang::Pt => format!("Resumo da atividade de codificação ({date})"),
        Lang::Ar => format!("ملخص نشاط البرمجة ({date})"),
        Lang::En => format!("Daily coding activity summary ({date})"),
    }
}

pub fn total_sessions(lang: Lang, count: u32) -> String {
    match lang {
        Lang::ZhCn => format!("会话总数: {count}"),
        Lang::ZhTw => format!("對話總數: {count}"),
        Lang::Ja => format!("セッション合計: {count}"),
        Lang::Ko => format!("총 세션: {count}"),
        Lang::Es => format!("Total de sesiones: {count}"),
        Lang::De => format!("Sitzungen gesamt: {count}"),
        Lang::Fr => format!("Sessions totales : {count}"),
        Lang::Pt => format!("Total de sessões: {count}"),
        Lang::Ar => format!("إجمالي الجلسات: {count}"),
        Lang::En => format!("Total sessions: {count}"),
    }
}

pub fn by_agent_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "按代理分布:",
        Lang::ZhTw => "按代理分佈:",
        Lang::Ja => "エージェント別:",
        Lang::Ko => "에이전트별:",
        Lang::Es => "Por agente:",
        Lang::De => "Nach Agent:",
        Lang::Fr => "Par agent :",
        Lang::Pt => "Por agente:",
        Lang::Ar => "حسب الوكيل:",
        Lang::En => "By agent:",
    }
}

pub fn agent_session_count(lang: Lang, agent: &str, count: u32) -> String {
    match lang {
        Lang::ZhCn => format!("{agent} - {count} 个会话"),
        Lang::ZhTw => format!("{agent} - {count} 個對話"),
        Lang::Ja => format!("{agent} - {count} セッション"),
        Lang::Ko => format!("{agent} - {count}개 세션"),
        Lang::Es => format!("{agent} - {count} sesiones"),
        Lang::De => format!("{agent} - {count} Sitzungen"),
        Lang::Fr => format!("{agent} - {count} sessions"),
        Lang::Pt => format!("{agent} - {count} sessões"),
        Lang::Ar => format!("{agent} - {count} جلسات"),
        Lang::En => format!("{agent} - {count} sessions"),
    }
}

pub fn projects_label(lang: Lang, projects: &str) -> String {
    match lang {
        Lang::ZhCn => format!("涉及项目: {projects}"),
        Lang::ZhTw => format!("涉及專案: {projects}"),
        Lang::Ja => format!("関連プロジェクト: {projects}"),
        Lang::Ko => format!("관련 프로젝트: {projects}"),
        Lang::Es => format!("Proyectos: {projects}"),
        Lang::De => format!("Projekte: {projects}"),
        Lang::Fr => format!("Projets : {projects}"),
        Lang::Pt => format!("Projetos: {projects}"),
        Lang::Ar => format!("المشاريع: {projects}"),
        Lang::En => format!("Projects: {projects}"),
    }
}

pub fn key_activities_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "主要活动:",
        Lang::ZhTw => "主要活動:",
        Lang::Ja => "主な活動:",
        Lang::Ko => "주요 활동:",
        Lang::Es => "Actividades clave:",
        Lang::De => "Wichtige Aktivitäten:",
        Lang::Fr => "Activités principales :",
        Lang::Pt => "Atividades principais:",
        Lang::Ar => "الأنشطة الرئيسية:",
        Lang::En => "Key activities:",
    }
}

// ── Command responses ──

pub fn query_failed_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "查询失败",
        Lang::ZhTw => "查詢失敗",
        Lang::Ja => "クエリ失敗",
        Lang::Ko => "조회 실패",
        Lang::Es => "Error de consulta",
        Lang::De => "Abfrage fehlgeschlagen",
        Lang::Fr => "Échec de la requête",
        Lang::Pt => "Falha na consulta",
        Lang::Ar => "فشل الاستعلام",
        Lang::En => "Query Failed",
    }
}

pub fn untitled(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "(无标题)",
        Lang::ZhTw => "(無標題)",
        Lang::Ja => "(無題)",
        Lang::Ko => "(제목 없음)",
        Lang::Es => "(Sin título)",
        Lang::De => "(Ohne Titel)",
        Lang::Fr => "(Sans titre)",
        Lang::Pt => "(Sem título)",
        Lang::Ar => "(بدون عنوان)",
        Lang::En => "(Untitled)",
    }
}

pub fn search_no_results(lang: Lang, keyword: &str) -> String {
    match lang {
        Lang::ZhCn => format!("未找到包含 \"{keyword}\" 的会话"),
        Lang::ZhTw => format!("未找到包含 \"{keyword}\" 的對話"),
        Lang::Ja => format!("\"{keyword}\" を含むセッションが見つかりません"),
        Lang::Ko => format!("\"{keyword}\"을(를) 포함하는 대화를 찾을 수 없습니다"),
        Lang::Es => format!("No se encontraron conversaciones con \"{keyword}\""),
        Lang::De => format!("Keine Sitzungen mit \"{keyword}\" gefunden"),
        Lang::Fr => format!("Aucune session trouvée avec \"{keyword}\""),
        Lang::Pt => format!("Nenhuma sessão encontrada com \"{keyword}\""),
        Lang::Ar => format!("لم يتم العثور على جلسات تحتوي على \"{keyword}\""),
        Lang::En => format!("No conversations found matching \"{keyword}\""),
    }
}

pub fn search_results_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "搜索结果",
        Lang::ZhTw => "搜尋結果",
        Lang::Ja => "検索結果",
        Lang::Ko => "검색 결과",
        Lang::Es => "Resultados",
        Lang::De => "Suchergebnisse",
        Lang::Fr => "Résultats",
        Lang::Pt => "Resultados",
        Lang::Ar => "نتائج البحث",
        Lang::En => "Search Results",
    }
}

pub fn search_results_count_title(lang: Lang, keyword: &str, count: usize) -> String {
    match lang {
        Lang::ZhCn => format!("搜索 \"{keyword}\" - {count} 条结果"),
        Lang::ZhTw => format!("搜尋 \"{keyword}\" - {count} 條結果"),
        Lang::Ja => format!("\"{keyword}\" の検索 - {count} 件"),
        Lang::Ko => format!("\"{keyword}\" 검색 - {count}건"),
        Lang::Es => format!("Buscar \"{keyword}\" - {count} resultados"),
        Lang::De => format!("Suche \"{keyword}\" - {count} Ergebnisse"),
        Lang::Fr => format!("Recherche \"{keyword}\" - {count} résultats"),
        Lang::Pt => format!("Busca \"{keyword}\" - {count} resultados"),
        Lang::Ar => format!("بحث \"{keyword}\" - {count} نتائج"),
        Lang::En => format!("Search \"{keyword}\" - {count} results"),
    }
}

pub fn no_activity_today(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "今日暂无编码活动",
        Lang::ZhTw => "今日暫無編碼活動",
        Lang::Ja => "本日のコーディング活動はありません",
        Lang::Ko => "오늘 코딩 활동이 없습니다",
        Lang::Es => "Sin actividad de codificación hoy",
        Lang::De => "Heute keine Coding-Aktivität",
        Lang::Fr => "Aucune activité de codage aujourd'hui",
        Lang::Pt => "Nenhuma atividade de codificação hoje",
        Lang::Ar => "لا يوجد نشاط برمجة اليوم",
        Lang::En => "No coding activity today",
    }
}

pub fn today_activity_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "今日活动",
        Lang::ZhTw => "今日活動",
        Lang::Ja => "本日の活動",
        Lang::Ko => "오늘의 활동",
        Lang::Es => "Actividad de hoy",
        Lang::De => "Heutige Aktivität",
        Lang::Fr => "Activité du jour",
        Lang::Pt => "Atividade de hoje",
        Lang::Ar => "نشاط اليوم",
        Lang::En => "Today's Activity",
    }
}

pub fn today_activity_date_title(lang: Lang, date: &str) -> String {
    match lang {
        Lang::ZhCn => format!("今日活动 ({date})"),
        Lang::ZhTw => format!("今日活動 ({date})"),
        Lang::Ja => format!("本日の活動 ({date})"),
        Lang::Ko => format!("오늘의 활동 ({date})"),
        Lang::Es => format!("Actividad de hoy ({date})"),
        Lang::De => format!("Heutige Aktivität ({date})"),
        Lang::Fr => format!("Activité du jour ({date})"),
        Lang::Pt => format!("Atividade de hoje ({date})"),
        Lang::Ar => format!("نشاط اليوم ({date})"),
        Lang::En => format!("Today's Activity ({date})"),
    }
}

pub fn agent_count(lang: Lang, agent: &str, count: u32) -> String {
    match lang {
        Lang::ZhCn => format!("{agent} - {count} 个"),
        Lang::ZhTw => format!("{agent} - {count} 個"),
        Lang::Ja => format!("{agent} - {count} 件"),
        Lang::Ko => format!("{agent} - {count}개"),
        Lang::Es | Lang::De | Lang::Fr | Lang::Pt | Lang::Ar | Lang::En => {
            format!("{agent} - {count}")
        }
    }
}

pub fn recent_activity_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "最近活动:",
        Lang::ZhTw => "最近活動:",
        Lang::Ja => "最近の活動:",
        Lang::Ko => "최근 활동:",
        Lang::Es => "Actividad reciente:",
        Lang::De => "Letzte Aktivität:",
        Lang::Fr => "Activité récente :",
        Lang::Pt => "Atividade recente:",
        Lang::Ar => "النشاط الأخير:",
        Lang::En => "Recent activity:",
    }
}

pub fn no_active_channels(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "暂无活跃渠道",
        Lang::ZhTw => "暫無活躍頻道",
        Lang::Ja => "アクティブなチャンネルなし",
        Lang::Ko => "활성 채널 없음",
        Lang::Es => "Sin canales activos",
        Lang::De => "Keine aktiven Kanäle",
        Lang::Fr => "Aucun canal actif",
        Lang::Pt => "Nenhum canal ativo",
        Lang::Ar => "لا توجد قنوات نشطة",
        Lang::En => "No active channels",
    }
}

pub fn channel_status_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "渠道状态",
        Lang::ZhTw => "頻道狀態",
        Lang::Ja => "チャンネル状況",
        Lang::Ko => "채널 상태",
        Lang::Es => "Estado de canales",
        Lang::De => "Kanalstatus",
        Lang::Fr => "Statut des canaux",
        Lang::Pt => "Status dos canais",
        Lang::Ar => "حالة القنوات",
        Lang::En => "Channel Status",
    }
}

pub fn help_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "Codeg Bot 帮助",
        Lang::ZhTw => "Codeg Bot 幫助",
        Lang::Ja => "Codeg Bot ヘルプ",
        Lang::Ko => "Codeg Bot 도움말",
        Lang::Es => "Ayuda de Codeg Bot",
        Lang::De => "Codeg Bot Hilfe",
        Lang::Fr => "Aide Codeg Bot",
        Lang::Pt => "Ajuda do Codeg Bot",
        Lang::Ar => "مساعدة Codeg Bot",
        Lang::En => "Codeg Bot Help",
    }
}

pub fn help_body(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!(
            "{prefix}folder - 选择工作目录\n\
             {prefix}agent - 选择 Agent\n\
             {prefix}task <描述> - 创建会话并执行任务\n\
             {prefix}sessions - 当前目录的活跃会话\n\
             {prefix}resume [ID] - 最近会话 / 恢复指定会话\n\
             {prefix}cancel - 取消当前任务\n\
             {prefix}approve [always] - 批准权限请求\n\
             {prefix}deny - 拒绝权限请求\n\
             \n\
             {prefix}search <关键词> - 搜索会话\n\
             {prefix}today - 今日活动汇总\n\
             {prefix}status - 渠道连接状态\n\
             {prefix}help - 显示帮助\n\
             \n\
             有活跃会话时，直接发文本即可继续对话"
        ),
        Lang::ZhTw => format!(
            "{prefix}folder - 選擇工作目錄\n\
             {prefix}agent - 選擇 Agent\n\
             {prefix}task <描述> - 建立對話並執行任務\n\
             {prefix}sessions - 當前目錄的活躍對話\n\
             {prefix}resume [ID] - 最近對話 / 恢復指定對話\n\
             {prefix}cancel - 取消當前任務\n\
             {prefix}approve [always] - 批准權限請求\n\
             {prefix}deny - 拒絕權限請求\n\
             \n\
             {prefix}search <關鍵字> - 搜尋對話\n\
             {prefix}today - 今日活動匯總\n\
             {prefix}status - 頻道連線狀態\n\
             {prefix}help - 顯示幫助\n\
             \n\
             有活躍對話時，直接發文字即可繼續對話"
        ),
        Lang::Ja => format!(
            "{prefix}folder - 作業フォルダを選択\n\
             {prefix}agent - エージェントを選択\n\
             {prefix}task <説明> - セッションを作成してタスクを実行\n\
             {prefix}sessions - フォルダ内のアクティブセッション\n\
             {prefix}resume [ID] - 最近のセッション / セッションを再開\n\
             {prefix}cancel - 現在のタスクをキャンセル\n\
             {prefix}approve [always] - 権限を承認\n\
             {prefix}deny - 権限を拒否\n\
             \n\
             {prefix}search <キーワード> - セッション検索\n\
             {prefix}today - 本日の活動まとめ\n\
             {prefix}status - チャンネル接続状況\n\
             {prefix}help - ヘルプを表示\n\
             \n\
             セッションがアクティブな場合、テキストを送信するだけで会話を続けられます"
        ),
        Lang::Ko => format!(
            "{prefix}folder - 작업 폴더 선택\n\
             {prefix}agent - 에이전트 선택\n\
             {prefix}task <설명> - 세션 생성 및 작업 실행\n\
             {prefix}sessions - 폴더 내 활성 세션\n\
             {prefix}resume [ID] - 최근 대화 / 세션 재개\n\
             {prefix}cancel - 현재 작업 취소\n\
             {prefix}approve [always] - 권한 승인\n\
             {prefix}deny - 권한 거부\n\
             \n\
             {prefix}search <키워드> - 대화 검색\n\
             {prefix}today - 오늘의 활동 요약\n\
             {prefix}status - 채널 연결 상태\n\
             {prefix}help - 도움말 표시\n\
             \n\
             세션이 활성화된 경우 텍스트를 보내면 대화를 계속할 수 있습니다"
        ),
        Lang::Es => format!(
            "{prefix}folder - Seleccionar carpeta de trabajo\n\
             {prefix}agent - Seleccionar agente\n\
             {prefix}task <desc> - Crear sesion y ejecutar tarea\n\
             {prefix}sessions - Sesiones activas en la carpeta\n\
             {prefix}resume [ID] - Recientes / reanudar una sesion\n\
             {prefix}cancel - Cancelar tarea actual\n\
             {prefix}approve [always] - Aprobar permiso\n\
             {prefix}deny - Denegar permiso\n\
             \n\
             {prefix}search <palabra> - Buscar conversaciones\n\
             {prefix}today - Resumen de hoy\n\
             {prefix}status - Estado de canales\n\
             {prefix}help - Mostrar ayuda\n\
             \n\
             Cuando hay una sesion activa, simplemente escriba texto para continuar"
        ),
        Lang::De => format!(
            "{prefix}folder - Arbeitsordner auswahlen\n\
             {prefix}agent - Agent auswahlen\n\
             {prefix}task <Beschreibung> - Sitzung erstellen und Aufgabe ausfuhren\n\
             {prefix}sessions - Aktive Sitzungen im Ordner\n\
             {prefix}resume [ID] - Neueste Sitzungen / Sitzung fortsetzen\n\
             {prefix}cancel - Aktuelle Aufgabe abbrechen\n\
             {prefix}approve [always] - Berechtigung genehmigen\n\
             {prefix}deny - Berechtigung verweigern\n\
             \n\
             {prefix}search <Stichwort> - Sitzungen suchen\n\
             {prefix}today - Heutige Zusammenfassung\n\
             {prefix}status - Kanalstatus\n\
             {prefix}help - Hilfe anzeigen\n\
             \n\
             Bei aktiver Sitzung einfach Text eingeben, um das Gesprach fortzusetzen"
        ),
        Lang::Fr => format!(
            "{prefix}folder - Selectionner le dossier de travail\n\
             {prefix}agent - Selectionner l'agent\n\
             {prefix}task <desc> - Creer une session et executer une tache\n\
             {prefix}sessions - Sessions actives dans le dossier\n\
             {prefix}resume [ID] - Sessions recentes / reprendre une session\n\
             {prefix}cancel - Annuler la tache en cours\n\
             {prefix}approve [always] - Approuver la permission\n\
             {prefix}deny - Refuser la permission\n\
             \n\
             {prefix}search <mot-cle> - Rechercher des sessions\n\
             {prefix}today - Resume du jour\n\
             {prefix}status - Statut des canaux\n\
             {prefix}help - Afficher l'aide\n\
             \n\
             Lorsqu'une session est active, envoyez du texte pour continuer la conversation"
        ),
        Lang::Pt => format!(
            "{prefix}folder - Selecionar pasta de trabalho\n\
             {prefix}agent - Selecionar agente\n\
             {prefix}task <desc> - Criar sessao e executar tarefa\n\
             {prefix}sessions - Sessoes ativas na pasta\n\
             {prefix}resume [ID] - Recentes / retomar uma sessao\n\
             {prefix}cancel - Cancelar tarefa atual\n\
             {prefix}approve [always] - Aprovar permissao\n\
             {prefix}deny - Negar permissao\n\
             \n\
             {prefix}search <palavra> - Buscar sessoes\n\
             {prefix}today - Resumo de hoje\n\
             {prefix}status - Status dos canais\n\
             {prefix}help - Mostrar ajuda\n\
             \n\
             Quando uma sessao esta ativa, basta digitar texto para continuar a conversa"
        ),
        Lang::Ar => format!(
            "{prefix}folder - اختيار مجلد العمل\n\
             {prefix}agent - اختيار الوكيل\n\
             {prefix}task <وصف> - انشاء جلسة وتنفيذ مهمة\n\
             {prefix}sessions - الجلسات النشطة في المجلد\n\
             {prefix}resume [ID] - الجلسات الاخيرة / استئناف جلسة\n\
             {prefix}cancel - الغاء المهمة الحالية\n\
             {prefix}approve [always] - الموافقة على الاذن\n\
             {prefix}deny - رفض الاذن\n\
             \n\
             {prefix}search <كلمة> - البحث في الجلسات\n\
             {prefix}today - ملخص اليوم\n\
             {prefix}status - حالة القنوات\n\
             {prefix}help - عرض المساعدة\n\
             \n\
             عندما تكون الجلسة نشطة، ارسل نصا لمتابعة المحادثة"
        ),
        Lang::En => format!(
            "{prefix}folder - Select working folder\n\
             {prefix}agent - Select agent\n\
             {prefix}task <desc> - Create session & run task\n\
             {prefix}sessions - Active sessions in folder\n\
             {prefix}resume [ID] - Recent conversations / resume a session\n\
             {prefix}cancel - Cancel current task\n\
             {prefix}approve [always] - Approve permission\n\
             {prefix}deny - Deny permission\n\
             \n\
             {prefix}search <keyword> - Search conversations\n\
             {prefix}today - Today's activity summary\n\
             {prefix}status - Channel connection status\n\
             {prefix}help - Show help\n\
             \n\
             When a session is active, just type text to continue the conversation"
        ),
    }
}

// ── Command dispatcher messages ──

pub fn invalid_args_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "参数错误",
        Lang::ZhTw => "參數錯誤",
        Lang::Ja => "引数エラー",
        Lang::Ko => "인수 오류",
        Lang::Es => "Argumentos inválidos",
        Lang::De => "Ungültige Argumente",
        Lang::Fr => "Arguments invalides",
        Lang::Pt => "Argumentos inválidos",
        Lang::Ar => "وسيطات غير صالحة",
        Lang::En => "Invalid Arguments",
    }
}

pub fn search_usage(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("用法: {prefix}search <关键词>"),
        Lang::ZhTw => format!("用法: {prefix}search <關鍵字>"),
        Lang::Ja => format!("使い方: {prefix}search <キーワード>"),
        Lang::Ko => format!("사용법: {prefix}search <키워드>"),
        Lang::Es => format!("Uso: {prefix}search <palabra>"),
        Lang::De => format!("Verwendung: {prefix}search <Stichwort>"),
        Lang::Fr => format!("Utilisation : {prefix}search <mot-clé>"),
        Lang::Pt => format!("Uso: {prefix}search <palavra>"),
        Lang::Ar => format!("الاستخدام: {prefix}search <كلمة>"),
        Lang::En => format!("Usage: {prefix}search <keyword>"),
    }
}

pub fn unknown_command(lang: Lang, prefix: &str, command: &str) -> String {
    match lang {
        Lang::ZhCn => format!("未知命令: {prefix}{command}\n输入 {prefix}help 查看可用命令"),
        Lang::ZhTw => format!("未知命令: {prefix}{command}\n輸入 {prefix}help 查看可用命令"),
        Lang::Ja => format!("不明なコマンド: {prefix}{command}\n{prefix}help でヘルプを表示"),
        Lang::Ko => format!("알 수 없는 명령: {prefix}{command}\n{prefix}help 로 도움말 보기"),
        Lang::Es => format!(
            "Comando desconocido: {prefix}{command}\nEscriba {prefix}help para ver los comandos"
        ),
        Lang::De => {
            format!("Unbekannter Befehl: {prefix}{command}\n{prefix}help für Hilfe eingeben")
        }
        Lang::Fr => {
            format!("Commande inconnue : {prefix}{command}\nTapez {prefix}help pour l'aide")
        }
        Lang::Pt => {
            format!("Comando desconhecido: {prefix}{command}\nDigite {prefix}help para ajuda")
        }
        Lang::Ar => format!("أمر غير معروف: {prefix}{command}\nاكتب {prefix}help لعرض المساعدة"),
        Lang::En => {
            format!("Unknown command: {prefix}{command}\nType {prefix}help for available commands")
        }
    }
}

pub fn unknown_command_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "未知命令",
        Lang::ZhTw => "未知命令",
        Lang::Ja => "不明なコマンド",
        Lang::Ko => "알 수 없는 명령",
        Lang::Es => "Comando desconocido",
        Lang::De => "Unbekannter Befehl",
        Lang::Fr => "Commande inconnue",
        Lang::Pt => "Comando desconhecido",
        Lang::Ar => "أمر غير معروف",
        Lang::En => "Unknown Command",
    }
}

// ── Session command messages ──

// Folder (/folder)
pub fn folder_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "工作目录",
        Lang::ZhTw => "工作目錄",
        Lang::Ja => "作業フォルダ",
        Lang::Ko => "작업 폴더",
        Lang::Es => "Carpeta de trabajo",
        Lang::De => "Arbeitsordner",
        Lang::Fr => "Dossier de travail",
        Lang::Pt => "Pasta de trabalho",
        Lang::Ar => "مجلد العمل",
        Lang::En => "Working Folder",
    }
}

pub fn no_folders_found(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "没有找到项目目录。",
        Lang::ZhTw => "沒有找到專案目錄。",
        Lang::Ja => "フォルダが見つかりません。",
        Lang::Ko => "폴더를 찾을 수 없습니다.",
        Lang::Es => "No se encontraron carpetas.",
        Lang::De => "Keine Ordner gefunden.",
        Lang::Fr => "Aucun dossier trouvé.",
        Lang::Pt => "Nenhuma pasta encontrada.",
        Lang::Ar => "لم يتم العثور على مجلدات.",
        Lang::En => "No folders found.",
    }
}

pub fn folder_select_hint(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("回复 {prefix}folder <数字> 选择目录。"),
        Lang::ZhTw => format!("回覆 {prefix}folder <數字> 選擇目錄。"),
        Lang::Ja => format!("{prefix}folder <番号> で選択してください。"),
        Lang::Ko => format!("{prefix}folder <번호>로 선택하세요."),
        Lang::Es => format!("Responde {prefix}folder <número> para seleccionar."),
        Lang::De => format!("Antworte {prefix}folder <Nummer> zur Auswahl."),
        Lang::Fr => format!("Répondez {prefix}folder <numéro> pour sélectionner."),
        Lang::Pt => format!("Responda {prefix}folder <número> para selecionar."),
        Lang::Ar => format!("أجب بـ {prefix}folder <رقم> للاختيار."),
        Lang::En => format!("Reply {prefix}folder <number> to select."),
    }
}

pub fn index_starts_from_one(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "序号从 1 开始。",
        Lang::ZhTw => "序號從 1 開始。",
        Lang::Ja => "インデックスは 1 から始まります。",
        Lang::Ko => "인덱스는 1부터 시작합니다.",
        Lang::Es => "El índice empieza desde 1.",
        Lang::De => "Index beginnt bei 1.",
        Lang::Fr => "L'index commence à 1.",
        Lang::Pt => "O índice começa em 1.",
        Lang::Ar => "يبدأ الفهرس من 1.",
        Lang::En => "Index starts from 1.",
    }
}

pub fn folder_index_out_of_range(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("序号超出范围，请使用 {prefix}folder 查看列表。"),
        Lang::ZhTw => format!("序號超出範圍，請使用 {prefix}folder 查看列表。"),
        Lang::Ja => {
            format!("インデックスが範囲外です。{prefix}folder でリストを確認してください。")
        }
        Lang::Ko => format!("인덱스가 범위를 벗어났습니다. {prefix}folder로 목록을 확인하세요."),
        Lang::Es => format!("Índice fuera de rango. Usa {prefix}folder para ver la lista."),
        Lang::De => {
            format!("Index außerhalb des Bereichs. {prefix}folder verwenden, um aufzulisten.")
        }
        Lang::Fr => format!("Index hors limites. Utilisez {prefix}folder pour lister."),
        Lang::Pt => format!("Índice fora de intervalo. Use {prefix}folder para listar."),
        Lang::Ar => format!("الفهرس خارج النطاق. استخدم {prefix}folder لعرض القائمة."),
        Lang::En => format!("Index out of range. Use {prefix}folder to list."),
    }
}

pub fn folder_selected_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已选择目录",
        Lang::ZhTw => "已選擇目錄",
        Lang::Ja => "フォルダを選択しました",
        Lang::Ko => "폴더 선택됨",
        Lang::Es => "Carpeta seleccionada",
        Lang::De => "Ordner ausgewählt",
        Lang::Fr => "Dossier sélectionné",
        Lang::Pt => "Pasta selecionada",
        Lang::Ar => "تم اختيار المجلد",
        Lang::En => "Folder Selected",
    }
}

pub fn folder_not_found(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "目录不存在。",
        Lang::ZhTw => "目錄不存在。",
        Lang::Ja => "フォルダが見つかりません。",
        Lang::Ko => "폴더를 찾을 수 없습니다.",
        Lang::Es => "Carpeta no encontrada.",
        Lang::De => "Ordner nicht gefunden.",
        Lang::Fr => "Dossier introuvable.",
        Lang::Pt => "Pasta não encontrada.",
        Lang::Ar => "المجلد غير موجود.",
        Lang::En => "Folder not found.",
    }
}

pub fn folder_not_found_with_hint(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("目录不存在，请使用 {prefix}folder 重新选择。"),
        Lang::ZhTw => format!("目錄不存在，請使用 {prefix}folder 重新選擇。"),
        Lang::Ja => format!("フォルダが見つかりません。{prefix}folder で選択してください。"),
        Lang::Ko => format!("폴더를 찾을 수 없습니다. {prefix}folder로 선택하세요."),
        Lang::Es => format!("Carpeta no encontrada. Usa {prefix}folder para seleccionar."),
        Lang::De => format!("Ordner nicht gefunden. {prefix}folder verwenden, um auszuwählen."),
        Lang::Fr => format!("Dossier introuvable. Utilisez {prefix}folder pour sélectionner."),
        Lang::Pt => format!("Pasta não encontrada. Use {prefix}folder para selecionar."),
        Lang::Ar => format!("المجلد غير موجود. استخدم {prefix}folder للاختيار."),
        Lang::En => format!("Folder not found. Use {prefix}folder to select."),
    }
}

pub fn no_folder_selected(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("未选择工作目录，请先使用 {prefix}folder 选择。"),
        Lang::ZhTw => format!("未選擇工作目錄，請先使用 {prefix}folder 選擇。"),
        Lang::Ja => {
            format!("フォルダが選択されていません。先に {prefix}folder を使用してください。")
        }
        Lang::Ko => format!("폴더가 선택되지 않았습니다. 먼저 {prefix}folder를 사용하세요."),
        Lang::Es => format!("Ninguna carpeta seleccionada. Usa {prefix}folder primero."),
        Lang::De => format!("Kein Ordner ausgewählt. Zuerst {prefix}folder verwenden."),
        Lang::Fr => format!("Aucun dossier sélectionné. Utilisez d'abord {prefix}folder."),
        Lang::Pt => format!("Nenhuma pasta selecionada. Use {prefix}folder primeiro."),
        Lang::Ar => format!("لم يتم اختيار مجلد. استخدم {prefix}folder أولاً."),
        Lang::En => format!("No folder selected. Use {prefix}folder first."),
    }
}

// Agent (/agent)
pub fn agent_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "选择 Agent",
        Lang::ZhTw => "選擇 Agent",
        Lang::Ja => "エージェント選択",
        Lang::Ko => "에이전트 선택",
        Lang::Es => "Selección de agente",
        Lang::De => "Agent-Auswahl",
        Lang::Fr => "Sélection d'agent",
        Lang::Pt => "Seleção de agente",
        Lang::Ar => "اختيار الوكيل",
        Lang::En => "Agent Selection",
    }
}

pub fn agent_select_hint(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("回复 {prefix}agent <数字> 或 {prefix}agent <名称> 选择。"),
        Lang::ZhTw => format!("回覆 {prefix}agent <數字> 或 {prefix}agent <名稱> 選擇。"),
        Lang::Ja => {
            format!("{prefix}agent <番号> または {prefix}agent <名前> で選択してください。")
        }
        Lang::Ko => format!("{prefix}agent <번호> 또는 {prefix}agent <이름>으로 선택하세요."),
        Lang::Es => {
            format!("Responde {prefix}agent <número> o {prefix}agent <nombre> para seleccionar.")
        }
        Lang::De => {
            format!("Antworte {prefix}agent <Nummer> oder {prefix}agent <Name> zur Auswahl.")
        }
        Lang::Fr => {
            format!("Répondez {prefix}agent <numéro> ou {prefix}agent <nom> pour sélectionner.")
        }
        Lang::Pt => {
            format!("Responda {prefix}agent <número> ou {prefix}agent <nome> para selecionar.")
        }
        Lang::Ar => format!("أجب بـ {prefix}agent <رقم> أو {prefix}agent <اسم> للاختيار."),
        Lang::En => format!("Reply {prefix}agent <number> or {prefix}agent <name> to select."),
    }
}

pub fn agent_index_out_of_range(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("序号超出范围，请使用 {prefix}agent 查看列表。"),
        Lang::ZhTw => format!("序號超出範圍，請使用 {prefix}agent 查看列表。"),
        Lang::Ja => format!("インデックスが範囲外です。{prefix}agent でリストを確認してください。"),
        Lang::Ko => format!("인덱스가 범위를 벗어났습니다. {prefix}agent로 목록을 확인하세요."),
        Lang::Es => format!("Índice fuera de rango. Usa {prefix}agent para ver la lista."),
        Lang::De => {
            format!("Index außerhalb des Bereichs. {prefix}agent verwenden, um aufzulisten.")
        }
        Lang::Fr => format!("Index hors limites. Utilisez {prefix}agent pour lister."),
        Lang::Pt => format!("Índice fora de intervalo. Use {prefix}agent para listar."),
        Lang::Ar => format!("الفهرس خارج النطاق. استخدم {prefix}agent لعرض القائمة."),
        Lang::En => format!("Index out of range. Use {prefix}agent to list."),
    }
}

pub fn agent_selected_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已选择 Agent",
        Lang::ZhTw => "已選擇 Agent",
        Lang::Ja => "エージェントを選択しました",
        Lang::Ko => "에이전트 선택됨",
        Lang::Es => "Agente seleccionado",
        Lang::De => "Agent ausgewählt",
        Lang::Fr => "Agent sélectionné",
        Lang::Pt => "Agente selecionado",
        Lang::Ar => "تم اختيار الوكيل",
        Lang::En => "Agent Selected",
    }
}

pub fn unknown_agent_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "未知 Agent: ",
        Lang::ZhTw => "未知 Agent: ",
        Lang::Ja => "不明なエージェント: ",
        Lang::Ko => "알 수 없는 에이전트: ",
        Lang::Es => "Agente desconocido: ",
        Lang::De => "Unbekannter Agent: ",
        Lang::Fr => "Agent inconnu : ",
        Lang::Pt => "Agente desconhecido: ",
        Lang::Ar => "وكيل غير معروف: ",
        Lang::En => "Unknown agent: ",
    }
}

// Task (/task)
pub fn task_usage(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("用法: {prefix}task <任务描述>"),
        Lang::ZhTw => format!("用法: {prefix}task <任務描述>"),
        Lang::Ja => format!("使い方: {prefix}task <タスク説明>"),
        Lang::Ko => format!("사용법: {prefix}task <작업 설명>"),
        Lang::Es => format!("Uso: {prefix}task <descripción>"),
        Lang::De => format!("Verwendung: {prefix}task <Beschreibung>"),
        Lang::Fr => format!("Usage : {prefix}task <description>"),
        Lang::Pt => format!("Uso: {prefix}task <descrição>"),
        Lang::Ar => format!("الاستخدام: {prefix}task <الوصف>"),
        Lang::En => format!("Usage: {prefix}task <description>"),
    }
}

pub fn no_agent_selected(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("未选择 Agent，请先使用 {prefix}agent 选择，或在工作目录上设置默认 Agent。"),
        Lang::ZhTw => format!("未選擇 Agent，請先使用 {prefix}agent 選擇，或在工作目錄上設定預設 Agent。"),
        Lang::Ja => format!("エージェントが選択されていません。{prefix}agent で選択するか、フォルダにデフォルトエージェントを設定してください。"),
        Lang::Ko => format!("에이전트가 선택되지 않았습니다. {prefix}agent로 선택하거나 폴더에 기본 에이전트를 설정하세요."),
        Lang::Es => format!("Ningún agente seleccionado. Usa {prefix}agent para elegir uno o define uno por defecto en la carpeta."),
        Lang::De => format!("Kein Agent ausgewählt. {prefix}agent verwenden oder Standard im Ordner festlegen."),
        Lang::Fr => format!("Aucun agent sélectionné. Utilisez {prefix}agent ou définissez un agent par défaut sur le dossier."),
        Lang::Pt => format!("Nenhum agente selecionado. Use {prefix}agent para escolher ou defina um padrão na pasta."),
        Lang::Ar => format!("لم يتم اختيار وكيل. استخدم {prefix}agent لاختيار واحد أو حدد وكيلًا افتراضيًا للمجلد."),
        Lang::En => format!("No agent selected. Use {prefix}agent to pick one or set a default on the folder."),
    }
}

pub fn failed_to_start_agent_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "启动 Agent 失败: ",
        Lang::ZhTw => "啟動 Agent 失敗: ",
        Lang::Ja => "エージェントの起動に失敗しました: ",
        Lang::Ko => "에이전트 시작 실패: ",
        Lang::Es => "Error al iniciar el agente: ",
        Lang::De => "Agent konnte nicht gestartet werden: ",
        Lang::Fr => "Échec du démarrage de l'agent : ",
        Lang::Pt => "Falha ao iniciar o agente: ",
        Lang::Ar => "فشل بدء الوكيل: ",
        Lang::En => "Failed to start agent: ",
    }
}

pub fn task_started_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "任务已启动",
        Lang::ZhTw => "任務已啟動",
        Lang::Ja => "タスク開始",
        Lang::Ko => "작업 시작됨",
        Lang::Es => "Tarea iniciada",
        Lang::De => "Aufgabe gestartet",
        Lang::Fr => "Tâche démarrée",
        Lang::Pt => "Tarefa iniciada",
        Lang::Ar => "تم بدء المهمة",
        Lang::En => "Task Started",
    }
}

// Sessions (/sessions)
pub fn sessions_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "会话列表",
        Lang::ZhTw => "對話列表",
        Lang::Ja => "セッション一覧",
        Lang::Ko => "세션 목록",
        Lang::Es => "Sesiones",
        Lang::De => "Sitzungen",
        Lang::Fr => "Sessions",
        Lang::Pt => "Sessões",
        Lang::Ar => "الجلسات",
        Lang::En => "Sessions",
    }
}

pub fn no_active_sessions_in_folder(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "当前目录没有进行中的会话。",
        Lang::ZhTw => "當前目錄沒有進行中的對話。",
        Lang::Ja => "このフォルダにアクティブなセッションはありません。",
        Lang::Ko => "이 폴더에 활성 세션이 없습니다.",
        Lang::Es => "No hay sesiones activas en esta carpeta.",
        Lang::De => "Keine aktiven Sitzungen in diesem Ordner.",
        Lang::Fr => "Aucune session active dans ce dossier.",
        Lang::Pt => "Nenhuma sessão ativa nesta pasta.",
        Lang::Ar => "لا توجد جلسات نشطة في هذا المجلد.",
        Lang::En => "No active sessions in this folder.",
    }
}

pub fn sessions_resume_hint(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("回复 {prefix}resume <会话ID> 继续会话。"),
        Lang::ZhTw => format!("回覆 {prefix}resume <對話ID> 繼續對話。"),
        Lang::Ja => format!("{prefix}resume <ID> で続行してください。"),
        Lang::Ko => format!("{prefix}resume <ID>로 계속하세요."),
        Lang::Es => format!("Responde {prefix}resume <id> para continuar."),
        Lang::De => format!("Antworte {prefix}resume <ID> zum Fortfahren."),
        Lang::Fr => format!("Répondez {prefix}resume <id> pour continuer."),
        Lang::Pt => format!("Responda {prefix}resume <id> para continuar."),
        Lang::Ar => format!("أجب بـ {prefix}resume <المعرف> للاستمرار."),
        Lang::En => format!("Reply {prefix}resume <id> to continue."),
    }
}

// Resume (/resume)
pub fn conversation_not_found(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "会话不存在。",
        Lang::ZhTw => "對話不存在。",
        Lang::Ja => "会話が見つかりません。",
        Lang::Ko => "대화를 찾을 수 없습니다.",
        Lang::Es => "Conversación no encontrada.",
        Lang::De => "Konversation nicht gefunden.",
        Lang::Fr => "Conversation introuvable.",
        Lang::Pt => "Conversa não encontrada.",
        Lang::Ar => "المحادثة غير موجودة.",
        Lang::En => "Conversation not found.",
    }
}

pub fn session_resumed_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "会话已恢复",
        Lang::ZhTw => "對話已恢復",
        Lang::Ja => "セッション再開",
        Lang::Ko => "세션 재개됨",
        Lang::Es => "Sesión reanudada",
        Lang::De => "Sitzung fortgesetzt",
        Lang::Fr => "Session reprise",
        Lang::Pt => "Sessão retomada",
        Lang::Ar => "تم استئناف الجلسة",
        Lang::En => "Session Resumed",
    }
}

pub fn no_conversations_found(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "暂无会话记录。",
        Lang::ZhTw => "暫無對話記錄。",
        Lang::Ja => "会話記録がありません。",
        Lang::Ko => "대화 기록이 없습니다.",
        Lang::Es => "No hay conversaciones.",
        Lang::De => "Keine Konversationen vorhanden.",
        Lang::Fr => "Aucune conversation trouvée.",
        Lang::Pt => "Nenhuma conversa encontrada.",
        Lang::Ar => "لا توجد محادثات.",
        Lang::En => "No conversations found.",
    }
}

pub fn recent_conversations_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "最近会话",
        Lang::ZhTw => "最近對話",
        Lang::Ja => "最近の会話",
        Lang::Ko => "최근 대화",
        Lang::Es => "Conversaciones recientes",
        Lang::De => "Letzte Konversationen",
        Lang::Fr => "Conversations récentes",
        Lang::Pt => "Conversas recentes",
        Lang::Ar => "المحادثات الأخيرة",
        Lang::En => "Recent Conversations",
    }
}

pub fn recent_resume_hint(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("回复 {prefix}resume <会话ID> 恢复会话。"),
        Lang::ZhTw => format!("回覆 {prefix}resume <對話ID> 恢復對話。"),
        Lang::Ja => format!("{prefix}resume <ID> でセッションを再開してください。"),
        Lang::Ko => format!("{prefix}resume <ID>로 세션을 재개하세요."),
        Lang::Es => format!("Responde {prefix}resume <id> para reanudar una sesión."),
        Lang::De => format!("Antworte {prefix}resume <ID> zum Fortsetzen einer Sitzung."),
        Lang::Fr => format!("Répondez {prefix}resume <id> pour reprendre une session."),
        Lang::Pt => format!("Responda {prefix}resume <id> para retomar uma sessão."),
        Lang::Ar => format!("أجب بـ {prefix}resume <المعرف> لاستئناف الجلسة."),
        Lang::En => format!("Reply {prefix}resume <id> to resume a session."),
    }
}

// Cancel (/cancel)
pub fn no_active_session_to_cancel(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "没有进行中的任务可取消。",
        Lang::ZhTw => "沒有進行中的任務可取消。",
        Lang::Ja => "キャンセルできるアクティブなセッションはありません。",
        Lang::Ko => "취소할 활성 세션이 없습니다.",
        Lang::Es => "No hay sesión activa para cancelar.",
        Lang::De => "Keine aktive Sitzung zum Abbrechen.",
        Lang::Fr => "Aucune session active à annuler.",
        Lang::Pt => "Nenhuma sessão ativa para cancelar.",
        Lang::Ar => "لا توجد جلسة نشطة للإلغاء.",
        Lang::En => "No active session to cancel.",
    }
}

pub fn task_cancelled_body(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "当前任务已取消。",
        Lang::ZhTw => "當前任務已取消。",
        Lang::Ja => "現在のタスクをキャンセルしました。",
        Lang::Ko => "현재 작업이 취소되었습니다.",
        Lang::Es => "La tarea actual ha sido cancelada.",
        Lang::De => "Aktuelle Aufgabe wurde abgebrochen.",
        Lang::Fr => "La tâche en cours a été annulée.",
        Lang::Pt => "A tarefa atual foi cancelada.",
        Lang::Ar => "تم إلغاء المهمة الحالية.",
        Lang::En => "Current task has been cancelled.",
    }
}

pub fn task_cancelled_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "任务已取消",
        Lang::ZhTw => "任務已取消",
        Lang::Ja => "タスクをキャンセルしました",
        Lang::Ko => "작업 취소됨",
        Lang::Es => "Tarea cancelada",
        Lang::De => "Aufgabe abgebrochen",
        Lang::Fr => "Tâche annulée",
        Lang::Pt => "Tarefa cancelada",
        Lang::Ar => "تم إلغاء المهمة",
        Lang::En => "Task Cancelled",
    }
}

// Permission (/approve, /deny)
pub fn no_active_session(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "没有活跃的会话。",
        Lang::ZhTw => "沒有活躍的對話。",
        Lang::Ja => "アクティブなセッションがありません。",
        Lang::Ko => "활성 세션이 없습니다.",
        Lang::Es => "No hay sesión activa.",
        Lang::De => "Keine aktive Sitzung.",
        Lang::Fr => "Aucune session active.",
        Lang::Pt => "Nenhuma sessão ativa.",
        Lang::Ar => "لا توجد جلسة نشطة.",
        Lang::En => "No active session.",
    }
}

pub fn no_active_session_found(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "未找到活跃的会话。",
        Lang::ZhTw => "未找到活躍的對話。",
        Lang::Ja => "アクティブなセッションが見つかりません。",
        Lang::Ko => "활성 세션을 찾을 수 없습니다.",
        Lang::Es => "No se encontró sesión activa.",
        Lang::De => "Keine aktive Sitzung gefunden.",
        Lang::Fr => "Aucune session active trouvée.",
        Lang::Pt => "Nenhuma sessão ativa encontrada.",
        Lang::Ar => "لم يتم العثور على جلسة نشطة.",
        Lang::En => "No active session found.",
    }
}

pub fn no_pending_permission(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "没有待处理的权限请求。",
        Lang::ZhTw => "沒有待處理的權限請求。",
        Lang::Ja => "保留中の権限要求はありません。",
        Lang::Ko => "대기 중인 권한 요청이 없습니다.",
        Lang::Es => "No hay solicitudes de permiso pendientes.",
        Lang::De => "Keine ausstehende Berechtigungsanfrage.",
        Lang::Fr => "Aucune demande d'autorisation en attente.",
        Lang::Pt => "Nenhuma solicitação de permissão pendente.",
        Lang::Ar => "لا توجد طلبات أذونات معلقة.",
        Lang::En => "No pending permission request.",
    }
}

pub fn no_allow_once_option(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "这个请求没有「只允许这一次」的选项，聊天里不会替你永久放行。请在 Codeg 中处理。",
        Lang::ZhTw => "這個請求沒有「只允許這一次」的選項，聊天裡不會替你永久放行。請在 Codeg 中處理。",
        Lang::Ja => "このリクエストには「今回のみ許可」の選択肢がなく、チャットから恒久的に許可することはしません。Codeg で応答してください。",
        Lang::Ko => "이 요청에는 '이번만 허용' 옵션이 없으며, 채팅에서는 영구 허용을 하지 않습니다. Codeg에서 처리하세요.",
        Lang::Es => "Esta solicitud no ofrece permitir solo esta vez, y desde el chat no se concede un permiso permanente. Respóndela en Codeg.",
        Lang::De => "Diese Anfrage bietet kein einmaliges Erlauben, und aus dem Chat wird keine dauerhafte Erlaubnis erteilt. Bitte in Codeg beantworten.",
        Lang::Fr => "Cette demande ne propose pas d'autoriser une seule fois, et le chat n'accorde pas d'autorisation permanente. Répondez-y dans Codeg.",
        Lang::Pt => "Esta solicitação não oferece permitir só desta vez, e pelo chat não se concede permissão permanente. Responda no Codeg.",
        Lang::Ar => "لا يتضمن هذا الطلب خيار السماح لمرة واحدة، ولا تمنح الدردشة إذنًا دائمًا. يرجى الرد عليه في Codeg.",
        Lang::En => "This request has no allow-once option, and chat won't grant a standing permission. Answer it in Codeg.",
    }
}

pub fn no_reject_once_option(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "这个请求没有「只拒绝这一次」的选项，聊天里不会替你设永久规则。请在 Codeg 中处理。",
        Lang::ZhTw => "這個請求沒有「只拒絕這一次」的選項，聊天裡不會替你設永久規則。請在 Codeg 中處理。",
        Lang::Ja => "このリクエストには「今回のみ拒否」の選択肢がなく、チャットから恒久的なルールは設定しません。Codeg で応答してください。",
        Lang::Ko => "이 요청에는 '이번만 거부' 옵션이 없으며, 채팅에서는 영구 규칙을 만들지 않습니다. Codeg에서 처리하세요.",
        Lang::Es => "Esta solicitud no ofrece rechazar solo esta vez, y desde el chat no se crea una regla permanente. Respóndela en Codeg.",
        Lang::De => "Diese Anfrage bietet kein einmaliges Ablehnen, und aus dem Chat wird keine dauerhafte Regel angelegt. Bitte in Codeg beantworten.",
        Lang::Fr => "Cette demande ne propose pas de refuser une seule fois, et le chat ne crée pas de règle permanente. Répondez-y dans Codeg.",
        Lang::Pt => "Esta solicitação não oferece recusar só desta vez, e pelo chat não se cria regra permanente. Responda no Codeg.",
        Lang::Ar => "لا يتضمن هذا الطلب خيار الرفض لمرة واحدة، ولا تنشئ الدردشة قاعدة دائمة. يرجى الرد عليه في Codeg.",
        Lang::En => "This request has no reject-once option, and chat won't set a standing rule. Answer it in Codeg.",
    }
}

pub fn failed_permission_response_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "权限响应失败: ",
        Lang::ZhTw => "權限回應失敗: ",
        Lang::Ja => "権限応答に失敗しました: ",
        Lang::Ko => "권한 응답 실패: ",
        Lang::Es => "Error al responder al permiso: ",
        Lang::De => "Berechtigungsantwort fehlgeschlagen: ",
        Lang::Fr => "Échec de la réponse à l'autorisation : ",
        Lang::Pt => "Falha ao responder à permissão: ",
        Lang::Ar => "فشل الاستجابة للإذن: ",
        Lang::En => "Failed to respond to permission: ",
    }
}

pub fn approved_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已批准",
        Lang::ZhTw => "已批准",
        Lang::Ja => "承認済み",
        Lang::Ko => "승인됨",
        Lang::Es => "Aprobado",
        Lang::De => "Genehmigt",
        Lang::Fr => "Approuvé",
        Lang::Pt => "Aprovado",
        Lang::Ar => "تمت الموافقة",
        Lang::En => "Approved",
    }
}

pub fn denied_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已拒绝",
        Lang::ZhTw => "已拒絕",
        Lang::Ja => "拒否",
        Lang::Ko => "거부됨",
        Lang::Es => "Denegado",
        Lang::De => "Abgelehnt",
        Lang::Fr => "Refusé",
        Lang::Pt => "Negado",
        Lang::Ar => "تم الرفض",
        Lang::En => "Denied",
    }
}

pub fn auto_approve_enabled(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已启用自动批准。",
        Lang::ZhTw => "已啟用自動批准。",
        Lang::Ja => "このセッションで自動承認を有効にしました。",
        Lang::Ko => "이 세션에 자동 승인을 활성화했습니다.",
        Lang::Es => "Aprobación automática activada para esta sesión.",
        Lang::De => "Automatische Genehmigung für diese Sitzung aktiviert.",
        Lang::Fr => "Approbation automatique activée pour cette session.",
        Lang::Pt => "Aprovação automática ativada para esta sessão.",
        Lang::Ar => "تم تفعيل الموافقة التلقائية لهذه الجلسة.",
        Lang::En => "Auto-approve enabled for this session.",
    }
}

pub fn permission_response_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "权限响应",
        Lang::ZhTw => "權限回應",
        Lang::Ja => "権限応答",
        Lang::Ko => "권한 응답",
        Lang::Es => "Respuesta de permiso",
        Lang::De => "Berechtigungsantwort",
        Lang::Fr => "Réponse d'autorisation",
        Lang::Pt => "Resposta de permissão",
        Lang::Ar => "استجابة الإذن",
        Lang::En => "Permission Response",
    }
}

// Follow-up
pub fn no_active_session_use_task(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("没有活跃的会话，请使用 {prefix}task 开始新任务。"),
        Lang::ZhTw => format!("沒有活躍的對話，請使用 {prefix}task 開始新任務。"),
        Lang::Ja => {
            format!("アクティブなセッションがありません。{prefix}task で開始してください。")
        }
        Lang::Ko => format!("활성 세션이 없습니다. {prefix}task로 시작하세요."),
        Lang::Es => format!("No hay sesión activa. Usa {prefix}task para iniciar una."),
        Lang::De => format!("Keine aktive Sitzung. {prefix}task zum Starten verwenden."),
        Lang::Fr => format!("Aucune session active. Utilisez {prefix}task pour en démarrer une."),
        Lang::Pt => format!("Nenhuma sessão ativa. Use {prefix}task para iniciar uma."),
        Lang::Ar => format!("لا توجد جلسة نشطة. استخدم {prefix}task لبدء واحدة."),
        Lang::En => format!("No active session. Use {prefix}task to start one."),
    }
}

pub fn session_connection_lost(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("会话连接已断开，请使用 {prefix}task 开始新任务。"),
        Lang::ZhTw => format!("對話連線已斷開，請使用 {prefix}task 開始新任務。"),
        Lang::Ja => {
            format!("セッション接続が切断されました。{prefix}task で新しく開始してください。")
        }
        Lang::Ko => format!("세션 연결이 끊어졌습니다. {prefix}task로 새로 시작하세요."),
        Lang::Es => format!("Conexión de sesión perdida. Usa {prefix}task para iniciar una nueva."),
        Lang::De => {
            format!("Sitzungsverbindung verloren. {prefix}task für neue Sitzung verwenden.")
        }
        Lang::Fr => format!(
            "Connexion de session perdue. Utilisez {prefix}task pour en démarrer une nouvelle."
        ),
        Lang::Pt => format!("Conexão da sessão perdida. Use {prefix}task para iniciar uma nova."),
        Lang::Ar => format!("انقطع اتصال الجلسة. استخدم {prefix}task لبدء جلسة جديدة."),
        Lang::En => format!("Session connection lost. Use {prefix}task to start a new one."),
    }
}

pub fn failed_to_send_message_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "发送消息失败: ",
        Lang::ZhTw => "發送訊息失敗: ",
        Lang::Ja => "メッセージの送信に失敗しました: ",
        Lang::Ko => "메시지 전송 실패: ",
        Lang::Es => "Error al enviar el mensaje: ",
        Lang::De => "Nachricht konnte nicht gesendet werden: ",
        Lang::Fr => "Échec de l'envoi du message : ",
        Lang::Pt => "Falha ao enviar mensagem: ",
        Lang::Ar => "فشل إرسال الرسالة: ",
        Lang::En => "Failed to send message: ",
    }
}

pub fn message_sent(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "消息已发送。",
        Lang::ZhTw => "訊息已發送。",
        Lang::Ja => "メッセージを送信しました。",
        Lang::Ko => "메시지를 보냈습니다.",
        Lang::Es => "Mensaje enviado.",
        Lang::De => "Nachricht gesendet.",
        Lang::Fr => "Message envoyé.",
        Lang::Pt => "Mensagem enviada.",
        Lang::Ar => "تم إرسال الرسالة.",
        Lang::En => "Message sent.",
    }
}

/// Shown when a prompt is rejected because the agent is still processing the
/// previous turn. Transient — the session stays alive; the user retries.
pub fn agent_busy_retry(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "智能体正在处理上一条消息，请稍后再发送。",
        Lang::ZhTw => "智慧代理正在處理上一則訊息，請稍後再發送。",
        Lang::Ja => "エージェントが前のメッセージを処理中です。少し待ってから再送信してください。",
        Lang::Ko => "에이전트가 이전 메시지를 처리 중입니다. 잠시 후 다시 보내 주세요.",
        Lang::Es => {
            "El agente sigue procesando el mensaje anterior; vuelve a enviarlo en un momento."
        }
        Lang::De => {
            "Der Agent verarbeitet noch die vorherige Nachricht – bitte gleich erneut senden."
        }
        Lang::Fr => "L'agent traite encore le message précédent ; renvoyez-le dans un instant.",
        Lang::Pt => {
            "O agente ainda está processando a mensagem anterior; envie novamente em instantes."
        }
        Lang::Ar => "لا يزال الوكيل يعالج الرسالة السابقة، يرجى إعادة الإرسال بعد قليل.",
        Lang::En => {
            "The agent is still processing the previous message — please send again in a moment."
        }
    }
}

/// Shown when a task's initial prompt arrives while another turn is already in
/// flight on the same (shared) connection. Unlike `agent_busy_retry`, the user
/// does NOT need to resend — the kickoff is deferred and runs automatically
/// once the current turn finishes.
pub fn task_deferred_busy(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "智能体正忙，任务将在当前回合结束后自动开始。",
        Lang::ZhTw => "智慧代理忙碌中，任務將在目前回合結束後自動開始。",
        Lang::Ja => "エージェントがビジー状態です。現在のターンが終了すると、タスクが自動的に開始されます。",
        Lang::Ko => "에이전트가 사용 중입니다. 현재 턴이 끝나면 작업이 자동으로 시작됩니다.",
        Lang::Es => "El agente está ocupado; la tarea comenzará automáticamente cuando finalice el turno actual.",
        Lang::De => "Der Agent ist beschäftigt; die Aufgabe startet automatisch, sobald der aktuelle Zug endet.",
        Lang::Fr => "L'agent est occupé ; la tâche démarrera automatiquement à la fin du tour en cours.",
        Lang::Pt => "O agente está ocupado; a tarefa começará automaticamente quando o turno atual terminar.",
        Lang::Ar => "الوكيل مشغول؛ ستبدأ المهمة تلقائيًا عند انتهاء الجولة الحالية.",
        Lang::En => {
            "The agent is busy — your task will start automatically once the current turn finishes."
        }
    }
}

// Internal error labels
pub fn failed_to_list_folders_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "列出目录失败: ",
        Lang::ZhTw => "列出目錄失敗: ",
        Lang::Ja => "フォルダ一覧の取得に失敗しました: ",
        Lang::Ko => "폴더 목록 조회 실패: ",
        Lang::Es => "Error al listar carpetas: ",
        Lang::De => "Auflisten der Ordner fehlgeschlagen: ",
        Lang::Fr => "Échec de la liste des dossiers : ",
        Lang::Pt => "Falha ao listar pastas: ",
        Lang::Ar => "فشل عرض المجلدات: ",
        Lang::En => "Failed to list folders: ",
    }
}

pub fn failed_to_add_folder_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "添加目录失败: ",
        Lang::ZhTw => "新增目錄失敗: ",
        Lang::Ja => "フォルダの追加に失敗しました: ",
        Lang::Ko => "폴더 추가 실패: ",
        Lang::Es => "Error al agregar carpeta: ",
        Lang::De => "Ordner konnte nicht hinzugefügt werden: ",
        Lang::Fr => "Échec de l'ajout du dossier : ",
        Lang::Pt => "Falha ao adicionar pasta: ",
        Lang::Ar => "فشل إضافة المجلد: ",
        Lang::En => "Failed to add folder: ",
    }
}

pub fn failed_to_load_context_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "加载上下文失败: ",
        Lang::ZhTw => "載入上下文失敗: ",
        Lang::Ja => "コンテキストの読み込みに失敗しました: ",
        Lang::Ko => "컨텍스트 로드 실패: ",
        Lang::Es => "Error al cargar contexto: ",
        Lang::De => "Kontext konnte nicht geladen werden: ",
        Lang::Fr => "Échec du chargement du contexte : ",
        Lang::Pt => "Falha ao carregar contexto: ",
        Lang::Ar => "فشل تحميل السياق: ",
        Lang::En => "Failed to load context: ",
    }
}

pub fn failed_to_create_conversation_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "创建会话失败: ",
        Lang::ZhTw => "建立對話失敗: ",
        Lang::Ja => "会話の作成に失敗しました: ",
        Lang::Ko => "대화 생성 실패: ",
        Lang::Es => "Error al crear conversación: ",
        Lang::De => "Konversation konnte nicht erstellt werden: ",
        Lang::Fr => "Échec de la création de la conversation : ",
        Lang::Pt => "Falha ao criar conversa: ",
        Lang::Ar => "فشل إنشاء المحادثة: ",
        Lang::En => "Failed to create conversation: ",
    }
}

pub fn failed_to_list_sessions_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "列出会话失败: ",
        Lang::ZhTw => "列出對話失敗: ",
        Lang::Ja => "セッション一覧の取得に失敗しました: ",
        Lang::Ko => "세션 목록 조회 실패: ",
        Lang::Es => "Error al listar sesiones: ",
        Lang::De => "Auflisten der Sitzungen fehlgeschlagen: ",
        Lang::Fr => "Échec de la liste des sessions : ",
        Lang::Pt => "Falha ao listar sessões: ",
        Lang::Ar => "فشل عرض الجلسات: ",
        Lang::En => "Failed to list sessions: ",
    }
}

// ── Session progress messages ──

pub fn agent_responding(lang: Lang, agent_label: &str) -> String {
    match lang {
        Lang::ZhCn => format!("{agent_label} 正在响应中..."),
        Lang::ZhTw => format!("{agent_label} 正在回應中..."),
        Lang::Ja => format!("{agent_label} が応答中..."),
        Lang::Ko => format!("{agent_label} 응답 중..."),
        Lang::Es => format!("{agent_label} respondiendo..."),
        Lang::De => format!("{agent_label} antwortet..."),
        Lang::Fr => format!("{agent_label} en cours de réponse..."),
        Lang::Pt => format!("{agent_label} respondendo..."),
        // FSI/PDI (U+2068/U+2069) isolate Latin agent name inside the Arabic RTL run so
        // bidi reordering stays predictable across Telegram/Lark/WeiXin clients.
        Lang::Ar => format!("\u{2068}{agent_label}\u{2069} يستجيب..."),
        Lang::En => format!("{agent_label} is responding..."),
    }
}
