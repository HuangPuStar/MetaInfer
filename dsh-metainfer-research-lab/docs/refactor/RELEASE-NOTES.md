# v2 发布说明（草稿）

## C14 — 迁移边界

- **C14：接受一次性停机割接是 owner 的决策，不是自动迁移能力。** v2 不会自动迁移 legacy 数据或双环状态；2026-11-10 10:04:28 的割接是 **Host 停机后重启**，不是不停机迁移，也没有 legacy/新双环长期共存承诺。发布说明不得写成“迁移已完成”或“无缝迁移”。

## 范围

- 本说明只记录 C14 的运维边界；其他 45 个 residual 行的分类、状态和 174 行账本见 [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) 与 [`ACCEPTANCE-LEDGER.md`](ACCEPTANCE-LEDGER.md)。
- 完整发布仍为 **NO-SHIP**，因为 15 个“必须”行（含 B22、U2、5.3.2）尚未全部独立关闭。
