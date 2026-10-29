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

## Cấu hình drone

Sau khi kết nối BLE, nhấn **SETUP**. Web gửi STOP, đặt joystick về 0, tạm
ngừng luồng điều khiển và tự đọc cấu hình hiện tại từ drone. Bảng gồm tâm,
giới hạn xung, đảo chiều từng servo, biên độ, tần số vỗ, gain pitch/roll/yaw
và bù biên độ khi rẽ.

- Tần số hiển thị bằng Hz, bước 0,1 Hz; gain hiển thị bằng µs, bước 5 µs.
- Mỗi tâm phải nằm cách hai giới hạn xung ít nhất 50 µs. Firmware kiểm tra
  lại toàn bộ tham số và trạng thái trước khi cho lưu.
- **READ FROM DRONE** đọc lại giá trị đang dùng, thay các chỉnh sửa chưa lưu.
- **SAVE TO FLASH** gửi cấu hình 20 byte với response, rồi đọc lại và so sánh.
  Chỉ báo thành công khi dữ liệu đọc lại hợp lệ và khớp. Không tự lưu hoặc tự
  thử ghi lại khi lỗi; nếu chưa xác nhận được kết quả, dùng READ FROM DRONE.
- **CLOSE** đóng bảng, đặt joystick về 0 và tiếp tục gửi điều khiển. Với ARM
  tùy chọn, công tắc vẫn OFF sau STOP và cần người dùng bật ON khi muốn chạy.
- Khi đang đọc/lưu, CLOSE tạm khóa; **DISCONNECT** vẫn dùng được để ngắt BLE.
  Kết quả của kết nối cũ không cập nhật bảng của kết nối mới.

Mọi thao tác đọc/ghi cấu hình và ghi control được tuần tự hóa trên cùng phiên
GATT. Trong lúc bảng mở, joystick không gửi lệnh; telemetry không quyết định
có cho phép gửi hoặc lưu hay không. Firmware vẫn sở hữu kiểm tra trạng thái.

Đọc hoặc mở bảng không ghi flash. Khi bật nguồn, firmware dùng cấu hình đã
lưu hoặc mặc định nếu chưa có dữ liệu hợp lệ. Cần firmware có characteristic
cấu hình `d4f20004-…`; firmware hiện tại trong repo đã có. Nếu drone không hỗ
trợ hoặc đọc lỗi, SAVE bị khóa; đóng bảng vẫn trở lại được điều khiển.

## Bật lại ARM sau khi thử điều khiển

Trong firmware, đổi `DRONE_REQUIRE_ARM` thành `1` ở
`main/include/drone_state.h` rồi build/nạp lại. Trong `fly/js/controller.js`,
đổi cấu hình mặc định `requireArm: false` thành `requireArm: true`.
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
| `d4f20004-8f69-4b7f-9f5a-6c253728d1a0` | Cấu hình 20 byte, read/write with response |

Version 1, little-endian, CRC16-CCITT-FALSE. Chi tiết từng trường nằm trong
[README firmware](../NimBLE_GATT_Server/README.md#giao-thức-ble).
`fly` cung cấp điều khiển, thống kê đường truyền và bảng cấu hình SETUP.

## Kiểm thử

Chạy kiểm thử web bằng Node.js, không cần cài thư viện:

```sh
bash /home/hanh/drone/fly/tests/run.sh
```

Kiểm thử cả web với state machine C và bộ trộn servo thực của firmware:

```sh
bash /home/hanh/drone/NimBLE_GATT_Server/tests/run.sh
```

Bộ kiểm thử tích hợp cần trình biên dịch C và Node.js. Nó nạp NippleJS đang
dùng và chạy callback GATT, state machine, bộ trộn servo thật của firmware;
transport BLE được thay bằng shim trên máy. Harness nạp script theo đúng thứ tự
trong HTML và chỉ trả về các ID thật sự tồn tại; test runner tự tìm các file
`tests/*.test.mjs`. Xem
[phạm vi kiểm tra](../NimBLE_GATT_Server/docs/INTEGRATION_CHECK.md).

## Cấu trúc

- `index.html`: markup, nạp các asset bằng script `defer` theo thứ tự phụ thuộc.
- `styles.css`: bố cục và giao diện responsive.
- `js/protocol.js`: control/telemetry/config codec, CRC và giới hạn đầu vào.
- `js/bluetooth.js`: API ghi tương thích Chrome/Bluefy, tuần tự hóa GATT theo phiên và định dạng lỗi.
- `js/joysticks.js`: adapter NippleJS, hình học và sự kiện pointer/touch.
- `js/settings.js`: form cấu hình, chuyển đổi đơn vị hiển thị và trạng thái đọc/lưu.
- `js/controller.js`: phiên BLE, hàng đợi STOP/joystick, thống kê và giao dịch cấu hình.
- `js/app.js`: entry point; giữ hỗ trợ `window.FLIGHT_CONTROL_CONFIG`.
- `nipplejs.min.js`, `NIPPLEJS_LICENSE.txt`: thư viện vendored đang dùng và giấy phép.
- `tests/`: kiểm thử host, chạy cùng entry point và các file JavaScript thực tế.

Web là static site, không có bước bundle hoặc dependency npm cần cài.
Khi triển khai, phục vụ toàn bộ các asset phía trên. Xem
[báo cáo cleanup](../NimBLE_GATT_Server/docs/CLEANUP_REPORT.md).
