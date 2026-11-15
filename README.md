# Web điều khiển ESP32-DRONE

`fly` là web điều khiển qua Web Bluetooth cho firmware Betaflight ESP32-C3 tại
`/home/hanh/Documents/project_hobby/drone/firmware/esp32s3-drone`.

## Chạy web

```sh
python3 -m http.server 8000 --directory /home/hanh/Documents/project_hobby/joystick/fly
```

Mở `http://localhost:8000` trong trình duyệt có Web Bluetooth. Khi dùng điện
thoại truy cập từ máy khác, phục vụ thư mục `fly` qua HTTPS; HTTP bằng địa chỉ
IP LAN không phải secure context. Trình duyệt cần cung cấp
`navigator.bluetooth` và quyền Bluetooth của hệ điều hành.

1. Nạp firmware `esp32s3-drone` vào ESP32-C3, bật Bluetooth trên máy điều khiển.
2. Nhấn **CONNECT BLE**, chọn **ESP32-DRONE**. Web đưa joystick về 0 và gửi
   một khung DISARM để hoàn tất bắt tay an toàn.
3. Giữ ga ở 0%, nhấn **ARM ON**, chờ trạng thái **ARMED**, rồi điều khiển bằng
   joystick trái (ga/yaw) và phải (roll/pitch).
   Ga giữ vị trí khi thả; yaw/pitch/roll trở về 0.
4. **STOP** gửi cờ STOP, đặt toàn bộ đầu vào về 0 và tắt ARM. Muốn tiếp tục phải
   nhấn **ARM ON** lại ở ga 0%. Ngắt kết nối cũng xóa đầu vào; firmware xử lý
   mất liên kết bằng watchdog 500 ms.
5. Đặt drone nằm phẳng, đứng yên rồi nhấn **CALIB**. Firmware tắt motor, chạy
   hiệu chuẩn IMU và báo **CALIBRATING** cho tới khi hoàn tất.

Nút ARM được bật mặc định cho firmware này. Ô **DRONE STATE** hiển thị
trạng thái board báo về: READY, SAFE, REJECTED hoặc FAILSAFE; UNKNOWN khi
chưa có/mất telemetry. Telemetry và RTT không chặn gửi lệnh.

Khi tab bị ẩn, web gửi STOP nếu có thể, xóa ARM và ngừng gửi đầu vào định kỳ.
Firmware có watchdog lệnh 500 ms và tự disarm khi mất lệnh. Khi tab hiện lại,
joystick vẫn ở trạng thái an toàn và phải ARM lại.

Luồng điều khiển mặc định 20 ms/lệnh, tối đa khoảng 50 Hz tùy đường BLE.
TX và RTT là giá trị trung bình trong cửa sổ 1,2 giây.

## Cấu hình drone

Firmware Betaflight ESP32-C3 hiện không cung cấp characteristic cấu hình
`d4f20004-…`, vì các tham số FC được quản lý bằng Betaflight Configurator/CLI.
Do đó nút **SETUP** được ẩn trong cấu hình web mặc định. Control và telemetry
không phụ thuộc characteristic này.

Mã hỗ trợ SETUP vẫn được giữ để dùng với target khác. Target đó phải truyền
`window.FLIGHT_CONTROL_CONFIG.configUuid` trước khi `js/app.js` chạy và cung cấp
characteristic 20 byte tương ứng. Không bật tùy chọn này cho firmware hiện tại.

Firmware yêu cầu một khung DISARM trước khi nhận ARM và từ chối ARM nếu ga lớn
hơn 5%. Web chỉ gửi yêu cầu; trạng thái **ARMED** luôn lấy từ telemetry của FC.

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
| `d4f20004-8f69-4b7f-9f5a-6c253728d1a0` | Tùy chọn cấu hình target khác; firmware hiện tại không cung cấp |

Version 1, little-endian, CRC16-CCITT-FALSE. Chi tiết control/status nằm trong
`idf/README.md` của project firmware. `fly` cung cấp joystick, ARM/STOP,
telemetry và thống kê đường truyền.

## Kiểm thử

Chạy kiểm thử web bằng Node.js, không cần cài thư viện:

```sh
bash /home/hanh/Documents/project_hobby/joystick/fly/tests/run.sh
```

Kiểm thử state machine BLE phía firmware từ thư mục `esp32s3-drone`:

```sh
cc -std=c11 -Wall -Wextra -Werror \
  -Iidf/components/drone_ble idf/components/drone_ble/control_protocol.c \
  idf/tests/control_protocol_test.c -o /tmp/drone-control-test
/tmp/drone-control-test
```

Bộ kiểm thử web nạp NippleJS đang dùng và chạy callback GATT với transport BLE
giả lập. Test C kiểm tra CRC, ARM/DISARM, STOP, replay và timeout của firmware.

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
Khi triển khai, phục vụ toàn bộ các asset phía trên.
