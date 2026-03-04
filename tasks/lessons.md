
### [2026-03-04] timingSafeEqualがP0修正時に退行
- **症状**: ===比較に戻りタイミング攻撃が可能に
- **原因**: P0修正集中時にtimingSafeCompare()を見落とし
- **修正**: crypto.timingSafeEqualを再実装
- **再発防止**: authMiddleware変更時はtimingSafeをCodex確認必須
- **発生回数**: 1/3
