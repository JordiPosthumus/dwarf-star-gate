#!/usr/bin/env python3
"""Fixed, unprivileged AppleSMC sensor reads. No write operation or CLI inputs.

SMC wire layout and read selectors are the public interoperability protocol used
by https://github.com/exelban/stats/blob/master/SMC/smc.swift . Sensor identities:
https://github.com/exelban/stats/blob/master/Modules/Sensors/values.swift .
Only system-total power and two individually named M3 temperature sensors are
requested; unavailable keys are omitted, never estimated from other components.
"""
import ctypes as C
import json
import math
import struct
import sys

SENSORS = ("PSTR", "Tf14", "Tf04")


class Version(C.Structure):
    _fields_ = [("major", C.c_uint8), ("minor", C.c_uint8),
                ("build", C.c_uint8), ("reserved", C.c_uint8), ("release", C.c_uint16)]


class Limits(C.Structure):
    _fields_ = [("version", C.c_uint16), ("length", C.c_uint16),
                ("cpu", C.c_uint32), ("gpu", C.c_uint32), ("memory", C.c_uint32)]


class Info(C.Structure):
    _fields_ = [("size", C.c_uint32), ("type", C.c_uint32), ("attributes", C.c_uint8)]


class Message(C.Structure):
    _fields_ = [("key", C.c_uint32), ("version", Version), ("limits", Limits),
                ("info", Info), ("result", C.c_uint8), ("status", C.c_uint8),
                ("operation", C.c_uint8), ("index", C.c_uint32), ("bytes", C.c_uint8 * 32)]


def decode(kind, data):
    if kind == b"flt " and len(data) == 4:
        value = struct.unpack("<f", data)[0]
    elif kind == b"sp78" and len(data) == 2:
        value = struct.unpack(">h", data)[0] / 256
    else:
        return None
    return value if math.isfinite(value) else None


def read_sensors():
    if sys.platform != "darwin":
        return {}
    if C.sizeof(Message) != 80 or Message.operation.offset != 42 or Message.bytes.offset != 48:
        return {}
    kit = C.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")
    system = C.CDLL("/usr/lib/libSystem.B.dylib")
    kit.IOServiceMatching.argtypes = [C.c_char_p]
    kit.IOServiceMatching.restype = C.c_void_p
    kit.IOServiceGetMatchingService.argtypes = [C.c_uint32, C.c_void_p]
    kit.IOServiceGetMatchingService.restype = C.c_uint32
    kit.IOServiceOpen.argtypes = [C.c_uint32, C.c_uint32, C.c_uint32, C.POINTER(C.c_uint32)]
    kit.IOServiceOpen.restype = C.c_int32
    kit.IOObjectRelease.argtypes = [C.c_uint32]
    kit.IOServiceClose.argtypes = [C.c_uint32]
    kit.IOConnectCallStructMethod.argtypes = [C.c_uint32, C.c_uint32, C.c_void_p, C.c_size_t,
                                            C.c_void_p, C.POINTER(C.c_size_t)]
    kit.IOConnectCallStructMethod.restype = C.c_int32
    service = kit.IOServiceGetMatchingService(0, kit.IOServiceMatching(b"AppleSMC"))
    if not service:
        return {}
    connection = C.c_uint32()
    result = kit.IOServiceOpen(service, C.c_uint32.in_dll(system, "mach_task_self_").value,
                               0, C.byref(connection))
    kit.IOObjectRelease(service)
    if result:
        return {}

    def read_call(message):
        if message.operation not in (5, 9):
            return None
        out = Message()
        size = C.c_size_t(C.sizeof(out))
        result = kit.IOConnectCallStructMethod(connection, 2, C.byref(message), C.sizeof(message),
                                               C.byref(out), C.byref(size))
        return out if result == 0 and size.value == 80 and out.result == 0 else None

    values = {}
    try:
        for key in SENSORS:
            message = Message()
            message.key = int.from_bytes(key.encode("ascii"), "big")
            message.operation = 9
            info = read_call(message)
            if info is None or info.info.size not in (2, 4):
                continue
            kind = info.info.type.to_bytes(4, "big")
            if kind not in (b"flt ", b"sp78"):
                continue
            message.info.size = info.info.size
            message.operation = 5
            out = read_call(message)
            if out is None:
                continue
            value = decode(kind, bytes(out.bytes)[:info.info.size])
            ceiling = 5000 if key == "PSTR" else 150
            # Zero is a common unavailable-sensor sentinel on AppleSMC.
            if value is not None and 0 < value <= ceiling:
                values[key] = value
    finally:
        kit.IOServiceClose(connection)
    return values


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit(2)
    try:
        values = read_sensors()
    except Exception:
        values = {}
    print(json.dumps({"schema": 1, "values": values}, allow_nan=False))
