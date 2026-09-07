// 測試的共用前置。
//
//   靠「今天剛好是供餐日、剛好有人按出勤」才跑得起來的測試，一週有五天
//   等於沒有測試。這裡把環境備好、跑完還原，讓測試哪一天跑都一樣。
//
//   四支測試共用同一份 —— 各自抄一份的話，供餐日規則改了會有四個地方要跟著改。

// 把今天暫時算成員工供餐日（現在的設定是週二、週四）。
// 回傳還原函式，測試結束一定要呼叫。
export async function ensureMealDay(api, today) {
  const dow = new Date(today + 'T00:00:00').getDay();
  // 沒有 GET /api/settings，供餐日從 /api/today 讀得到
  const before = ((await api('/api/today')).staff_meal_dows || [2, 4]).join(',');
  const list = before.split(',').map(x => x.trim()).filter(Boolean);
  const added = !list.includes(String(dow));
  if (added) {
    await api('/api/settings', 'PUT',
      { staff_meal_dows: [...list, String(dow)].join(',') });
  }
  return async () => {
    if (added) await api('/api/settings', 'PUT', { staff_meal_dows: before });
  };
}

// 讓今天有出勤紀錄。沒有人按出勤時，排產用「在編人數」估、扣庫存用實際出勤，
// 兩邊本來就會不一樣 —— 那是合理的差異，拿它當「兩條路一致」的基準會誤報。
export async function ensureAttendance(api, today, howMany = Infinity) {
  const users = await api('/api/users');
  const now = ((await api('/api/today')).staff || [])
    .filter(x => x.date === today && x.attending === 1).map(x => x.user_id);
  const made = [];
  for (const u of (users || []).slice(0, howMany === Infinity ? undefined : howMany)) {
    if (!now.includes(u.id)) {
      await api('/api/today/attendance/' + u.id, 'PUT', { attending: 1, meal_time: '1130' });
      made.push(u.id);
    }
  }
  return async () => {
    for (const id of made) {
      await api('/api/today/attendance/' + id, 'PUT', { attending: 0, meal_time: '1130' })
        .catch(() => {});
    }
  };
}
