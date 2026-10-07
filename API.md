# C5官方API接入评估（2026-10-07）

结论：**API适合批量取得C5价格和数量，有助于扩大候选清单；不能代替Steam成交量、Steam求购深度和手续费计算。** 此版本继续使用用户可见网页数据，尚未启用需要账户授权的C5 API。

## 优先核验的接口

|官方接口|对推荐的价值|当前文档条件|
|---|---|---|
|POST /merchant/market/v2/item/stat/hash/name|按精确市场名批量返回sellPrice、sellCount、purchaseMaxPrice、purchaseCount及itemId|app-key；每批最多100条|
|POST /merchant/product/price/batch|按市场名批量返回最低在售价、数量和商品链接|app-key；文档仍标记“开发中”|
|POST /merchant/market/v2/products/list|具体在售报价及DOTA2宝石/款式属性，可帮助核验实际可买商品|app-key和IP白名单；文档标记内测|
|POST https://partner.c5game.com/api/price/v1/min|按itemId批量返回最低价，区分自动/人工发货价及数量|伙伴平台client_id/client_secret；最多200件每批|

sellCount、purchaseCount为在售/求购数量，不是已成交数量。取得API返回并不等于完成可交易时间、补贴/预售条件或Steam同版本核验。

## 开通和费用状态

[官方接入指南](https://opendoc.c5game.com/)说明普通开放平台app-key需在C5个人中心API管理申请。2026-09-10 [官方公告](https://www.c5game.com/en/wiki/541578214.html)宣布将推出API会员制，但该公告未确定最终上线时间和个人账户价格/可用权益，应以账户页面实际显示为准。

日志、缓存和GitHub代码只保存公开商品报价；密钥应留在本机配置或受控服务端。接入时仅调用查询类接口，不调用购买、求购创建、上架、改价或取消订单接口。只在确认该账户获得相应查询权限后进行小批量实测。

## 接入后的处理

按DOTA2 appId=570和精确marketHashName请求，保留itemId及取数时间；展示C5最低价与页面标价差异，买入前重新核验商品详情。按实际文档配额缓存与限频，不采用高并发扫全市场。接口错误或无权限时保留网页模式，不切换到未授权接口。

接口批量数量字段有利于筛选C5货源；推荐排序仍使用“C5总成本/Steam扣费到账”，结合Steam近期成交、同币种盘口价差及顶档深度。没有Steam端数据时只能给待核验列表。

依据：[批量统计信息](https://opendoc.c5game.com/api-304298359)、[批量最低价](https://opendoc.c5game.com/api-125914570)、[在售查询](https://opendoc.c5game.com/api-414956575)、[伙伴平台价格查询](https://partnerdoc.c5game.com/180852827e0)。
