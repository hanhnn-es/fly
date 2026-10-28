# Web điều khiển ESP32-DRONE

`/home/hanh/drone/fly` là web điều khiển của firmware
[`NimBLE_GATT_Server`](../NimBLE_GATT_Server/README.md).

## Chạy web

```sh
python3 -m http.server 8000 --directory /home/hanh/drone/fly
```

Mở `http://localhost:8000` trong trình duyệt có Web Bluetooth. Khi dùng điện
thoại truy cập từ máy khác, phục vụ thư mục `fly` qua HTTPS; HTTP bằng địa chỉ
IP LAN không phải secure context. Trình duyệt cần cung cấp
`navigator.bluetooth` và quyền Bluetooth của hệ điều hành.

1. Nạp firmware `NimBLE_GATT_Server` vào ESP32, bật Bluetooth trên máy điều khiển.
2. Nhấn **CONNECT BLE**, chọn **ESP32-DRONE**. Web đưa joystick về 0 và bắt
   đầu gửi lệnh. Chế độ mặc định tạm vô hiệu hóa ARM ở cả web và firmware.
3. Điều khiển ngay bằng joystick trái (ga/yaw) và phải (roll/pitch).
   Ga giữ vị trí khi thả; yaw/pitch/roll trở về 0.
4. **STOP** gửi cờ STOP và đặt toàn bộ đầu vào web về 0. Lệnh joystick tiếp
   theo tiếp tục điều khiển ngay, không cần ARM lại. Ngắt kết nối cũng xóa
   đầu vào web; firmware xử lý mất liên kết.

Nút ARM được ẩn trong chế độ điều khiển trực tiếp. Ô **DRONE STATE** hiển thị
trạng thái board báo về: READY, SAFE, REJECTED hoặc FAILSAFE; UNKNOWN khi
chưa có/mất telemetry. Telemetry và RTT không chặn gửi lệnh.

Khi tab bị ẩn, web ngừng gửi đầu vào định kỳ. Firmware có watchdog lệnh
500 ms và đưa cánh về tâm khi timeout. Khi tab hiện lại, lệnh hợp lệ tiếp
theo tiếp tục điều khiển với giá trị joystick hiện tại, không cần ARM.

Luồng điều khiển mặc định 20 ms/lệnh, tối đa khoảng 50 Hz tùy đường BLE.
TX và RTT là giá trị trung bình trong cửa sổ 1,2 giây.

## Bật lại ARM sau khi thử điều khiển

Trong firmware, đổi `DRONE_REQUIRE_ARM` thành `1` ở
`main/include/drone_control.h` rồi build/nạp lại. Trong `fly/index.html`,
đổi cấu hình mặc định `requireArm:false` thành `requireArm:true`.
Khi đó nút ARM ON/OFF xuất hiện lại; firmware yêu cầu OFF ở ga ≤5% trước ON.
Web chỉ gửi giá trị công tắc, không tự thực hiện handshake hoặc chờ ACK.

## Chrome trên Ubuntu báo Web Bluetooth unavailable

1. Mở `chrome://flags/#enable-experimental-web-platform-features` trong thanh
   địa chỉ Chrome, đặt **Experimental Web Platform features → Enabled**, rồi
   nhấn **Relaunch**. [Tài liệu Chrome](https://developer.chrome.com/docs/capabilities/bluetooth)
   yêu cầu bật flag này trên Linux.
2. Chạy HTTP server như trên và mở **`http://localhost:8000`** trên cùng máy
   Ubuntu. Khi truy cập từ máy khác, dùng HTTPS. API cần secure context.
3. Bật Bluetooth trong **Settings → Bluetooth**, rồi nhấn **CONNECT BLE**.

Nếu vẫn lỗi, mở **F12 → Console** và kiểm tra:

```js
({
  secure: window.isSecureContext,
  bluetooth: typeof navigator.bluetooth,
  requestDevice: typeof navigator.bluetooth?.requestDevice
})
```

Giá trị mong đợi: `secure: true`, `bluetooth: "object"`,
`requestDevice: "function"`. Nếu API đã có nhưng không tìm thấy board,
mở `chrome://bluetooth-internals` để xem Chrome có nhận adapter Bluetooth
hay không, kiểm tra board đang quảng bá và chưa bị thiết bị khác kết nối.

## Giao thức

| UUID | Chức năng |
| --- | --- |
| `d4f20001-8f69-4b7f-9f5a-6c253728d1a0` | Service |
| `d4f20002-8f69-4b7f-9f5a-6c253728d1a0` | Control 14 byte, write/write without response |
| `d4f20003-8f69-4b7f-9f5a-6c253728d1a0` | Telemetry/ACK 8 byte, notify |

Version 1, little-endian, CRC16-CCITT-FALSE. Chi tiết từng trường nằm trong
[README firmware](../NimBLE_GATT_Server/README.md#giao-thức-ble).
`fly` hiện có điều khiển và thống kê đường truyền; chưa có giao diện hiệu
chỉnh servo cho characteristic cấu hình `d4f20004-…`.

## Kiểm thử

Chạy kiểm thử web bằng Node.js, không cần cài thư viện:

```sh
node /home/hanh/drone/fly/tests/controller.test.mjs
node /home/hanh/drone/fly/tests/nipplejs.test.mjs
```

Kiểm thử cả web với state machine C và bộ trộn servo thực của firmware:

```sh
bash /home/hanh/drone/NimBLE_GATT_Server/tests/run.sh
```

Bộ kiểm thử tích hợp cần trình biên dịch C và Node.js. Nó nạp NippleJS đang
dùng và chạy callback GATT, state machine, bộ trộn servo thật của firmware;
transport BLE được thay bằng shim trên máy. Xem
[phạm vi kiểm tra](../NimBLE_GATT_Server/docs/INTEGRATION_CHECK.md).
