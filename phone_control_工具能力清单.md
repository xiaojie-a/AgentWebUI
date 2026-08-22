# Agent Mini 手机控制工具 (phone_control) 能力清单

> 共 **22 个可操作动作** · 全部命令以 root (`su -c`) 执行 · 单命令超时 10 秒

| 分类 | 动作(action) | 说明 | 参数 | 底层命令 | 实测状态 |
|---|---|---|---|---|---|
| 屏幕 | `screen_on` | 点亮屏幕 | 无 | `input keyevent 224` | ✅ 实测通过 |
| 屏幕 | `screen_off` | 熄灭屏幕 | 无 | `input keyevent 223` | ✅ 实测通过 |
| 屏幕 | `screen_keep` | 保持/恢复屏幕常亮 | keep: 是否常亮(默认 true) | `svc power stayon true/false` | ✅ 实测通过 |
| 截图 | `screenshot` | 截屏保存 PNG 到 Termux 家目录 | 无 | `screencap -p <path>` | ✅ 实测通过 |
| 反馈 | `vibrate` | 震动 | value: 震动毫秒(默认300, 范围50-10000) | `cmd vibrator_manager synced oneshot -B <ms>` | ✅ 实测通过 |
| 反馈 | `volume_set` | 设置媒体音量 | value: 音量0-15(默认10) | `cmd media_session volume --stream 3 --set <n>` | ✅ 实测通过 |
| 反馈 | `notify` | 发送系统通知 | title: 标题(默认Agent)；text: 内容 | `cmd notification post -t <title> <tag> <content>` | ✅ 实测通过 |
| 定位 | `location` | 获取最近定位(经纬度) | 无 | `dumpsys location \| grep last location` | ✅ 实测通过 |
| 模拟操作 | `tap` | 点击屏幕坐标 | x, y: 坐标 | `input tap x y` | ✅ 实测通过 |
| 模拟操作 | `swipe` | 滑动屏幕 | x, y, x2, y2；duration: 时长ms(默认200) | `input swipe x y x2 y2 duration` | ✅ 实测通过 |
| 模拟操作 | `keyevent` | 发送按键 | keycode(默认3；3=Home 4=返回 26=电源 224=亮屏 223=息屏 164=静音) | `input keyevent <code>` | ✅ 实测通过 |
| 模拟操作 | `input_text` | 输入文字 | text: 要输入的文字 | `input text '<text>'` | ✅ 实测通过 |
| 连接 | `wifi_on` | 开启 WiFi | 无 | `cmd wifi set-wifi-enabled enabled` | ✅ 实测通过 |
| 连接 | `wifi_off` | 关闭 WiFi | 无 | `cmd wifi set-wifi-enabled disabled` | ✅ 实测通过 |
| 连接 | `bt_on` | 开启蓝牙 | 无 | `cmd bluetooth_manager enable` | ✅ 实测通过 |
| 连接 | `bt_off` | 关闭蓝牙 | 无 | `cmd bluetooth_manager disable` | ✅ 实测通过 |
| RGB灯 | `rgb` | 控制呼吸灯 | text: red/green/blue(默认green)；keep: 点亮(默认true)/熄灭 | `echo > /sys/class/leds/<color>/brightness` | ✅ 实测通过 |
| 应用管理 | `app_start` | 启动应用 | package: 包名(如 com.android.settings) | `monkey -p <pkg> -c LAUNCHER 1` | ✅ 实测通过 |
| 应用管理 | `app_stop` | 强制停止应用 | package: 包名 | `am force-stop <pkg>` | ✅ 实测通过 |
| 应用管理 | `app_list` | 列出第三方应用(可按关键字过滤) | package: 过滤关键字(可选) | `pm list packages -3 [filter]` | ✅ 实测通过 |
| 剪贴板 | `clipboard_get` | 读取剪贴板内容 | 无 | `cmd clipboard get` | ⚠️ 本机不支持(厂商裁剪 cmd clipboard) |
| 剪贴板 | `clipboard_set` | 写入剪贴板 | text: 内容 | `cmd clipboard set text <text>` | ⚠️ 本机不支持(厂商裁剪) |

- 说明：phone_control 工具 = Agent Mini 手机控制插件，共 22 个可操作动作；所有命令均以 root(su -c) 执行，单命令超时 10 秒。
- 实测设备：Moto XT2533 (SM7435, Android 15)。截图文件保存至 /data/data/com.termux/files/home/screen_<时间戳>.png。
- 剪贴板：Moto 厂商裁剪了 cmd clipboard（get/set 均无实现），本机不可用；代码已保留，换支持 cmd clipboard 的设备自动可用。
- 闪光灯 torch：已从工具枚举移除。本机相机 HAL 独占闪光灯，sysfs 直写会锁死 torch(曾致系统手电筒失效)；安全路径 termux-torch 需 Termux:API App(签名与 Play 版 Termux 不匹配装不上)，暂搁置。