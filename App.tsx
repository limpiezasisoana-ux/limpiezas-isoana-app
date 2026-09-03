import React, { useEffect, useState } from "react";
import {
  SafeAreaView, View, Text, StyleSheet, ScrollView, Image,
  TouchableOpacity, TextInput, Linking, Alert, ActivityIndicator, Platform
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { supabase } from "./src/supabase";
import PrivacyConsentModal, { usePrivacyConsent } from "./src/PrivacyConsent";
import { registerForPushNotifications } from "./src/notifications";

type Tab = "inicio" | "reservar" | "reserva" | "planes" | "contacto" | "cuenta" | "personal" | "admin";
type Service = { id:string; name:string; description?:string|null; base_price?:number|null };
type Plan = { id:string; name:string; description?:string|null; base_price?:number|null };

const PHONE = "642148996";
const WHATSAPP = "34642148996";

export default function App() {
  // Empieza en "Cuenta" para que la primera pantalla sea Iniciar sesión / Darme de alta.
  // Si hay sesión guardada, se pasa a "inicio" automáticamente en cuanto se recupera.
  const [tab, setTab] = useState<Tab>("cuenta");
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const consent = usePrivacyConsent();
  const [services, setServices] = useState<Service[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [planId, setPlanId] = useState<string | null>(null);
  const [bookings, setBookings] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authMode, setAuthMode] = useState<"login"|"register">("login");
  const [role, setRole] = useState<"client"|"staff"|"admin">("client");
  const [staffBookings, setStaffBookings] = useState<any[]>([]);
  const [adminBookings, setAdminBookings] = useState<any[]>([]);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [adminServices, setAdminServices] = useState<any[]>([]);
  const [adminPlans, setAdminPlans] = useState<any[]>([]);
  const [servicePriceDrafts, setServicePriceDrafts] = useState<Record<string,string>>({});
  const [planPriceDrafts, setPlanPriceDrafts] = useState<Record<string,string>>({});
  const [clientList, setClientList] = useState<any[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => {
      setSession(data.session);
      if (data.session?.user?.id) {
        loadProfileRole(data.session.user.id);
        setTab("inicio");
      }
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s?.user?.id) loadProfileRole(s.user.id);
      else {
        setRole("client");
        setStaffBookings([]);
      }
    });
    loadCatalog();
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user?.id) {
      loadBookings();
      if (role === "staff" || role === "admin") loadStaffBookings();
      if (role === "admin") loadAdminData();
      const channel = supabase.channel("booking-updates")
        .on("postgres_changes", { event:"*", schema:"public", table:"bookings" }, (payload:any) => {
          loadBookings();
          if (role === "staff" || role === "admin") loadStaffBookings();
          if (role === "admin") loadAdminData();
          // Aviso dentro de la app para el personal/admin si la tienen abierta
          // cuando entra una reserva nueva (además del push que llega aunque esté cerrada).
          if (payload.eventType === "INSERT" && (role === "staff" || role === "admin")) {
            const b = payload.new;
            Alert.alert(
              "Nueva reserva",
              `${b?.customer_name || "Un cliente"} ha reservado un servicio.`
            );
          }
        })
        .subscribe();
      return () => { supabase.removeChannel(channel); };
    } else {
      setBookings([]);
      setStaffBookings([]);
    }
  }, [session?.user?.id, role]);

  async function loadProfileRole(userId:string) {
    const {data} = await supabase.from("profiles").select("role").eq("id", userId).single();
    const r = (data?.role || "client") as "client"|"staff"|"admin";
    setRole(r);
    if (r === "staff" || r === "admin") {
      // Registra el dispositivo para recibir notificaciones push de nuevas reservas.
      registerForPushNotifications(userId).catch(() => {});
    }
  }

  async function loadStaffBookings() {
    if (!session?.user?.id || (role !== "staff" && role !== "admin")) return;
    const {data,error} = await supabase
      .from("bookings")
      .select("id,status,scheduled_at,service_address,customer_name,customer_phone,assigned_staff_id,services(name),maintenance_plans(name)")
      .in("status", ["received","confirmed","on_the_way","in_progress"])
      .order("scheduled_at",{ascending:true});
    if (!error) setStaffBookings(data || []);
  }

  async function claimBooking(bookingId:string) {
    if (!session?.user?.id) return;
    const {error} = await supabase
      .from("bookings")
      .update({assigned_staff_id: session.user.id, status:"confirmed"})
      .eq("id", bookingId);
    if (error) Alert.alert("No se pudo asignar", error.message);
    else loadStaffBookings();
  }

  async function advanceBooking(b:any) {
    if (!session?.user?.id) return;
    const next:any = {
      confirmed:"on_the_way",
      on_the_way:"in_progress",
      in_progress:"completed"
    };
    const nextStatus = next[b.status];
    if (!nextStatus) return;
    const {error} = await supabase
      .from("bookings")
      .update({status: nextStatus})
      .eq("id", b.id);
    if (error) Alert.alert("No se pudo actualizar", error.message);
    else loadStaffBookings();
  }

  async function loadAdminData() {
    if (!session?.user?.id || role !== "admin") return;
    const [b, st, sv, pl, cl] = await Promise.all([
      supabase
        .from("bookings")
        .select("id,status,scheduled_at,service_address,customer_name,customer_phone,payment_status,assigned_staff_id,services(name)")
        .order("created_at",{ascending:false})
        .limit(100),
      supabase
        .from("profiles")
        .select("id,full_name,phone,role")
        .in("role",["staff","admin"])
        .order("full_name"),
      supabase
        .from("services")
        .select("id,name,base_price,active")
        .order("name"),
      supabase
        .from("maintenance_plans")
        .select("id,name,price_per_visit,active")
        .order("name"),
      supabase
        .from("profiles")
        .select("id,full_name,phone,role")
        .eq("role","client")
        .order("full_name")
    ]);
    if (!b.error) setAdminBookings(b.data || []);
    if (!st.error) setStaffList(st.data || []);
    if (!sv.error) setAdminServices(sv.data || []);
    if (!pl.error) setAdminPlans(pl.data || []);
    if (!cl.error) setClientList(cl.data || []);
  }

  async function changeUserRole(profileId:string, newRole:"client"|"staff") {
    const {error} = await supabase
      .from("profiles")
      .update({role:newRole})
      .eq("id", profileId);
    if (error) {
      Alert.alert("No se pudo cambiar el usuario", error.message);
      return;
    }
    Alert.alert(
      "Actualizado",
      newRole === "staff"
        ? "Usuario añadido al personal."
        : "Usuario retirado del personal."
    );
    loadAdminData();
  }

  async function assignStaff(bookingId:string, staffId:string|null) {
    const {error} = await supabase
      .from("bookings")
      .update({assigned_staff_id: staffId, status: staffId ? "confirmed" : "received"})
      .eq("id", bookingId);
    if (error) Alert.alert("No se pudo asignar", error.message);
    else loadAdminData();
  }

  async function adminSetStatus(bookingId:string, status:string) {
    const {error} = await supabase.from("bookings").update({status}).eq("id", bookingId);
    if (error) Alert.alert("No se pudo cambiar el estado", error.message);
    else loadAdminData();
  }

  async function updateServicePrice(id:string, value:string) {
    const price = Number(value.replace(",", "."));
    if (isNaN(price) || price < 0) {
      return Alert.alert("Precio no válido", "Introduce un precio correcto.");
    }
    const {error} = await supabase
      .from("services")
      .update({base_price: price})
      .eq("id", id);
    if (error) {
      Alert.alert("No se pudo actualizar", error.message);
    } else {
      Alert.alert("Precio actualizado", `Nuevo precio: ${price} €`);
      loadAdminData();
    }
  }

  async function updatePlanPrice(id:string, value:string) {
    const price = Number(value.replace(",", "."));
    if (isNaN(price) || price < 0) {
      return Alert.alert("Precio no válido", "Introduce un precio correcto.");
    }
    const {error} = await supabase
      .from("maintenance_plans")
      .update({price_per_visit: price})
      .eq("id", id);
    if (error) {
      Alert.alert("No se pudo actualizar", error.message);
    } else {
      Alert.alert("Precio actualizado", `Nuevo precio: ${price} € por visita`);
      loadAdminData();
    }
  }

  async function loadCatalog() {
    const [{data:s},{data:p}] = await Promise.all([
      supabase.from("services").select("id,name,description,base_price").eq("active", true).order("name"),
      supabase.from("maintenance_plans").select("id,name,description,base_price:price_per_visit").eq("active", true).order("name")
    ]);
    setServices(s || []);
    setPlans(p || []);
    if (s?.length) setServiceId(s[0].id);
  }

  async function signInOrRegister() {
    if (!email || !password) return Alert.alert("Faltan datos","Escribe email y contraseña.");
    if (authMode === "login") {
      const {error} = await supabase.auth.signInWithPassword({email,password});
      if (error) Alert.alert("No se pudo iniciar sesión", error.message);
      else setTab("inicio");
    } else {
      const {error} = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: authName,
            phone: authPhone
          },
          emailRedirectTo: "limpiezasisoana://auth/callback"
        }
      });
      if (error) Alert.alert("No se pudo crear la cuenta", error.message);
      else Alert.alert("Cuenta creada","Si Supabase solicita confirmar el correo, revisa tu bandeja de entrada.");
    }
  }

  async function loadBookings() {
    if (!session?.user?.id) return;
    const {data,error} = await supabase
      .from("bookings")
      .select("id,status,scheduled_at,service_address,payment_status,customer_name,customer_phone,services(name),maintenance_plans(name)")
      .eq("client_id", session.user.id)
      .order("created_at",{ascending:false});
    if (!error) setBookings(data || []);
  }

  async function createBooking() {
    if (!session) {
      Alert.alert("Inicia sesión","Necesitas una cuenta para guardar tu reserva.");
      setTab("cuenta");
      return;
    }
    if (!serviceId || !name || !phone || !address || !date) {
      return Alert.alert("Faltan datos","Completa servicio, nombre, teléfono, dirección y fecha.");
    }
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) {
      return Alert.alert("Fecha no válida","Usa un formato como 2026-09-05T10:00");
    }
    const {error} = await supabase.from("bookings").insert({
      client_id: session.user.id,
      service_id: serviceId,
      maintenance_plan_id: planId,
      customer_name: name,
      customer_phone: phone,
      service_address: address,
      scheduled_at: parsed.toISOString(),
      notes,
      status: "received",
      payment_status: "pending",
      reservation_amount: 20
    });
    if (error) return Alert.alert("No se pudo reservar",error.message);
    Alert.alert("Reserva creada","Tu reserva ya está guardada en la base de datos.");
    setTab("reserva");
    loadBookings();
  }

  const statusLabel = (s:string) => ({
    received:"Reserva recibida", confirmed:"Confirmada", on_the_way:"Personal en camino",
    in_progress:"Trabajo en curso", completed:"Finalizado", cancelled:"Cancelada"
  } as any)[s] || s;

  const openCall = () => Linking.openURL(`tel:${PHONE}`);
  const openWhatsApp = () => Linking.openURL(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent("Hola, quiero información sobre un servicio de Limpiezas Isoana.")}`);
  const openMaps = (q:string="Valencia, España") => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`);

  return (
    <>
      <PrivacyConsentModal
        visible={consent.visible}
        onAcceptAll={() => consent.saveConsent(false)}
        onlyNecessary={() => consent.saveConsent(true)}
      />

      {loading ? (
        <SafeAreaView style={s.safe}><ActivityIndicator style={{marginTop:80}} size="large"/></SafeAreaView>
      ) : (
        <SafeAreaView style={s.safe}>
          <StatusBar style="light"/>
          <View style={s.header}>
            <Image source={require("./assets/limpiezas-isoana.png")} style={s.logo}/>
            <View style={{flex:1}}>
              <Text style={s.brand}>Limpiezas Isoana</Text>
              <Text style={s.tag}>Limpieza profesional · Valencia y alrededores</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={s.content}>
            {tab==="inicio" && <>
              <View style={s.hero}>
                <Text style={s.heroTitle}>Reserva tu limpieza a domicilio</Text>
                <Text style={s.heroText}>Reserva real, seguimiento del servicio y planes de mantenimiento.</Text>
                <TouchableOpacity style={s.primary} onPress={()=>setTab("reservar")}><Text style={s.primaryText}>RESERVAR AHORA</Text></TouchableOpacity>
              </View>
              <Text style={s.section}>Servicios</Text>
              <View style={s.grid}>{services.map(x=>
                <TouchableOpacity key={x.id} style={s.card} onPress={()=>{setServiceId(x.id);setTab("reservar")}}>
                  <Text style={s.itemTitle}>{x.name}</Text>
                  <Text style={s.small}>A domicilio</Text>
                  {x.base_price != null && (
                    <Text style={s.small}>Desde {x.base_price} € / hora</Text>
                  )}
                </TouchableOpacity>)}
              </View>
            </>}

            {tab==="cuenta" && <>
              <Text style={s.section}>{authMode==="login"?"Iniciar sesión":"Crear cuenta"}</Text>
              {authMode==="register" && <>
                <TextInput style={s.input} placeholder="Nombre completo" value={authName} onChangeText={setAuthName}/>
                <TextInput style={s.input} placeholder="Teléfono" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad"/>
              </>}
              <TextInput style={s.input} placeholder="Email" autoCapitalize="none" value={email} onChangeText={setEmail}/>
              <TextInput style={s.input} placeholder="Contraseña" secureTextEntry value={password} onChangeText={setPassword}/>
              <TouchableOpacity style={s.primary} onPress={signInOrRegister}><Text style={s.primaryText}>{authMode==="login"?"ENTRAR":"CREAR CUENTA"}</Text></TouchableOpacity>
              <TouchableOpacity style={s.secondary} onPress={()=>setAuthMode(authMode==="login"?"register":"login")}>
                <Text style={s.secondaryText}>{authMode==="login"?"No tengo cuenta":"Ya tengo cuenta"}</Text>
              </TouchableOpacity>
              {session && <TouchableOpacity style={s.secondary} onPress={()=>supabase.auth.signOut()}><Text style={s.secondaryText}>CERRAR SESIÓN</Text></TouchableOpacity>}
              <TouchableOpacity style={s.secondary} onPress={consent.reopen}>
                <Text style={s.secondaryText}>PRIVACIDAD Y ALMACENAMIENTO LOCAL</Text>
              </TouchableOpacity>
            </>}

            {tab==="reservar" && <>
              <Text style={s.section}>Nueva reserva</Text>
              <Text style={s.label}>Servicio</Text>
              {services.map(x=><TouchableOpacity key={x.id} style={[s.option, serviceId===x.id&&s.optionActive]} onPress={()=>setServiceId(x.id)}>
                <Text style={serviceId===x.id?s.optionTextActive:s.optionText}>
                  {x.name}{x.base_price != null ? ` · Desde ${x.base_price} € / hora` : ""}
                </Text>
              </TouchableOpacity>)}
              <Text style={[s.label,{marginTop:14}]}>Plan de mantenimiento (opcional)</Text>
              <TouchableOpacity style={[s.option,!planId&&s.optionActive]} onPress={()=>setPlanId(null)}><Text style={!planId?s.optionTextActive:s.optionText}>Servicio puntual</Text></TouchableOpacity>
              {plans.map(x=><TouchableOpacity key={x.id} style={[s.option, planId===x.id&&s.optionActive]} onPress={()=>setPlanId(x.id)}>
                <Text style={planId===x.id?s.optionTextActive:s.optionText}>
                  {x.name}{x.base_price != null ? ` · Desde ${x.base_price} € / hora` : ""}
                </Text>
              </TouchableOpacity>)}
              <TextInput style={s.input} placeholder="Nombre y apellidos" value={name} onChangeText={setName}/>
              <TextInput style={s.input} placeholder="Teléfono" value={phone} onChangeText={setPhone} keyboardType="phone-pad"/>
              <TextInput style={s.input} placeholder="Dirección del servicio" value={address} onChangeText={setAddress}/>
              <TextInput style={s.input} placeholder="Fecha: 2026-09-05T10:00" value={date} onChangeText={setDate}/>
              <TextInput style={[s.input,{height:90}]} multiline placeholder="Observaciones" value={notes} onChangeText={setNotes}/>
              <TouchableOpacity style={s.primary} onPress={createBooking}><Text style={s.primaryText}>CONFIRMAR RESERVA</Text></TouchableOpacity>
            </>}

            {tab==="reserva" && <>
              <Text style={s.section}>Mis reservas</Text>
              {!session ? <View style={s.infoBox}><Text>Inicia sesión para ver tus reservas.</Text></View> :
              bookings.length===0 ? <View style={s.infoBox}><Text>No tienes reservas todavía.</Text></View> :
              bookings.map(b=><View style={s.booking} key={b.id}>
                <Text style={s.bookingCode}>{b.services?.name || "Servicio"}</Text>
                <Text style={s.bookingLine}>{statusLabel(b.status)}</Text>
                <Text style={s.bookingLine}>{new Date(b.scheduled_at).toLocaleString()}</Text>
                <Text style={s.bookingLine}>{b.service_address}</Text>
                <Text style={s.bookingLine}>Pago: {b.payment_status}</Text>
                {b.payment_status === "pending" && (
                  <TouchableOpacity
                    style={s.primary}
                    onPress={() =>
                      Linking.openURL(
                        `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(
                          `Hola, quiero realizar el pago de mi reserva de Limpiezas Isoana.\nServicio: ${b.services?.name || "Limpieza"}\nFecha: ${new Date(b.scheduled_at).toLocaleString()}`
                        )}`
                      )
                    }
                  >
                    <Text style={s.primaryText}>PAGAR / CONTACTAR POR WHATSAPP</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={s.secondary}
                  onPress={() => openMaps(b.service_address)}
                >
                  <Text style={s.secondaryText}>VER EN GPS</Text>
                </TouchableOpacity>
              </View>)}
            </>}

            {tab==="planes" && <>
              <Text style={s.section}>Planes de mantenimiento</Text>
              {plans.map(p=><View style={s.planCard} key={p.id}>
                <Text style={s.planName}>{p.name}</Text>
                <Text style={s.planDesc}>{p.description}</Text>
                {p.base_price != null && (
                  <Text style={s.planDesc}>Desde {p.base_price} € / hora</Text>
                )}
                <TouchableOpacity style={s.primary} onPress={()=>{setPlanId(p.id);setTab("reservar")}}><Text style={s.primaryText}>ELEGIR PLAN</Text></TouchableOpacity>
              </View>)}
            </>}

            {tab==="admin" && <>
              <Text style={s.section}>Administración</Text>
              {role!=="admin" ? (
                <View style={s.infoBox}>
                  <Text style={{color:"#38506B"}}>Esta zona es solo para administradores.</Text>
                </View>
              ) : <>
                <Text style={s.subsection}>Reservas</Text>
                {adminBookings.length===0 ? (
                  <View style={s.infoBox}><Text>No hay reservas todavía.</Text></View>
                ) : adminBookings.map(b=><View style={s.booking} key={b.id}>
                  <Text style={s.bookingCode}>{b.services?.name || "Servicio"}</Text>
                  <Text style={s.bookingLine}>Cliente: {b.customer_name}</Text>
                  <Text style={s.bookingLine}>Teléfono: {b.customer_phone}</Text>
                  <Text style={s.bookingLine}>{new Date(b.scheduled_at).toLocaleString()}</Text>
                  <Text style={s.bookingLine}>{b.service_address}</Text>
                  <Text style={[s.bookingLine,{fontWeight:"800"}]}>Estado: {statusLabel(b.status)}</Text>
                  <Text style={s.bookingLine}>Pago: {b.payment_status}</Text>
                  {b.payment_status !== "paid" ? (
                    <TouchableOpacity
                      style={[s.primary,{marginTop:12}]}
                      onPress={async () => {
                        const {error} = await supabase
                          .from("bookings")
                          .update({payment_status:"paid"})
                          .eq("id",b.id);
                        if (error) {
                          Alert.alert("Error",error.message);
                        } else {
                          Alert.alert("Pago actualizado","La reserva está marcada como pagada.");
                          loadAdminData();
                          loadBookings();
                        }
                      }}
                    >
                      <Text style={s.primaryText}>MARCAR COMO PAGADO</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={[s.label,{marginTop:12}]}>✅ PAGO REALIZADO</Text>
                  )}
                  <Text style={[s.label,{marginTop:12}]}>Asignar trabajador</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <TouchableOpacity style={s.staffChip} onPress={()=>assignStaff(b.id,null)}>
                      <Text style={s.staffChipText}>Sin asignar</Text>
                    </TouchableOpacity>
                    {staffList.filter(x=>x.role==="staff").map(st=>
                      <TouchableOpacity
                        key={st.id}
                        style={[s.staffChip,b.assigned_staff_id===st.id&&s.staffChipActive]}
                        onPress={()=>assignStaff(b.id,st.id)}>
                        <Text style={b.assigned_staff_id===st.id?s.staffChipTextActive:s.staffChipText}>
                          {st.full_name || "Trabajador"}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </ScrollView>
                  <Text style={[s.label,{marginTop:12}]}>Cambiar estado</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {["received","confirmed","on_the_way","in_progress","completed","cancelled"].map(st=>
                      <TouchableOpacity
                        key={st}
                        style={[s.statusChip,b.status===st&&s.statusChipActive]}
                        onPress={()=>adminSetStatus(b.id,st)}>
                        <Text style={b.status===st?s.statusChipTextActive:s.statusChipText}>{statusLabel(st)}</Text>
                      </TouchableOpacity>
                    )}
                  </ScrollView>
                  <TouchableOpacity style={s.secondary} onPress={()=>Linking.openURL(`tel:${b.customer_phone}`)}>
                    <Text style={s.secondaryText}>LLAMAR CLIENTE</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.secondary} onPress={()=>openMaps(b.service_address)}>
                    <Text style={s.secondaryText}>VER DIRECCIÓN EN GPS</Text>
                  </TouchableOpacity>
                </View>)}

                <Text style={s.subsection}>Precios de servicios</Text>
                {adminServices.map(x => (
                  <View key={x.id} style={s.adminRow}>
                    <View style={{flex:1}}>
                      <Text style={s.adminTitle}>{x.name}</Text>
                      <Text style={s.adminMuted}>
                        {x.base_price == null ? "Sin precio" : `${x.base_price} €`}
                      </Text>
                      <TextInput
                        style={s.input}
                        keyboardType="decimal-pad"
                        placeholder="Nuevo precio €"
                        value={servicePriceDrafts[x.id] ?? ""}
                        onChangeText={(value) =>
                          setServicePriceDrafts(prev => ({...prev, [x.id]: value}))
                        }
                      />
                      <TouchableOpacity
                        style={s.smallButton}
                        onPress={() => {
                          const value = servicePriceDrafts[x.id];
                          if (!value) {
                            Alert.alert("Falta el precio", "Escribe el nuevo precio.");
                            return;
                          }
                          updateServicePrice(x.id, value);
                        }}
                      >
                        <Text style={s.smallButtonText}>GUARDAR PRECIO</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}

                <Text style={s.subsection}>Planes de mantenimiento</Text>
                {adminPlans.map(x => (
                  <View key={x.id} style={s.adminRow}>
                    <View style={{flex:1}}>
                      <Text style={s.adminTitle}>{x.name}</Text>
                      <Text style={s.adminMuted}>
                        {x.price_per_visit == null ? "Sin precio" : `${x.price_per_visit} € / visita`}
                      </Text>
                      <TextInput
                        style={s.input}
                        keyboardType="decimal-pad"
                        placeholder="Nuevo precio por visita €"
                        value={planPriceDrafts[x.id] ?? ""}
                        onChangeText={(value) =>
                          setPlanPriceDrafts(prev => ({...prev, [x.id]: value}))
                        }
                      />
                      <TouchableOpacity
                        style={s.smallButton}
                        onPress={() => {
                          const value = planPriceDrafts[x.id];
                          if (!value) {
                            Alert.alert("Falta el precio", "Escribe el nuevo precio.");
                            return;
                          }
                          updatePlanPrice(x.id, value);
                        }}
                      >
                        <Text style={s.smallButtonText}>GUARDAR PRECIO</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}

                <Text style={s.subsection}>Equipo</Text>
                {staffList
                  .filter(st => st.role === "staff")
                  .map(st => (
                    <View key={st.id} style={s.adminRow}>
                      <View style={{flex:1}}>
                        <Text style={s.adminTitle}>
                          {st.full_name || "Sin nombre"}
                        </Text>
                        <Text style={s.adminMuted}>
                          {st.phone || "Sin teléfono"}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={s.smallButton}
                        onPress={() => changeUserRole(st.id, "client")}
                      >
                        <Text style={s.smallButtonText}>QUITAR</Text>
                      </TouchableOpacity>
                    </View>
                  ))}

                <Text style={s.subsection}>Añadir personal</Text>
                {clientList.length === 0 ? (
                  <View style={s.infoBox}>
                    <Text>No hay clientes disponibles para añadir.</Text>
                  </View>
                ) : (
                  clientList.map(cl => (
                    <View key={cl.id} style={s.adminRow}>
                      <View style={{flex:1}}>
                        <Text style={s.adminTitle}>
                          {cl.full_name || "Sin nombre"}
                        </Text>
                        <Text style={s.adminMuted}>
                          {cl.phone || "Sin teléfono"}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={s.smallButton}
                        onPress={() => changeUserRole(cl.id, "staff")}
                      >
                        <Text style={s.smallButtonText}>AÑADIR</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </>}
            </>}

            {tab==="personal" && <>
              <Text style={s.section}>Panel del personal</Text>
              {role!=="staff" && role!=="admin" ? (
                <View style={s.infoBox}>
                  <Text style={{color:"#38506B",lineHeight:20}}>Esta zona es solo para trabajadores autorizados de Limpiezas Isoana.</Text>
                </View>
              ) : staffBookings.length===0 ? (
                <View style={s.infoBox}><Text>No hay servicios activos pendientes.</Text></View>
              ) : staffBookings.map(b=><View style={s.booking} key={b.id}>
                <Text style={s.bookingCode}>{b.services?.name || "Servicio"}</Text>
                <Text style={s.bookingLine}>Cliente: {b.customer_name}</Text>
                <Text style={s.bookingLine}>Teléfono: {b.customer_phone}</Text>
                <Text style={s.bookingLine}>{new Date(b.scheduled_at).toLocaleString()}</Text>
                <Text style={s.bookingLine}>{b.service_address}</Text>
                <Text style={[s.bookingLine,{fontWeight:"800",color:"#0B2E59"}]}>{statusLabel(b.status)}</Text>
                {!b.assigned_staff_id && (
                  <TouchableOpacity style={s.primary} onPress={()=>claimBooking(b.id)}>
                    <Text style={s.primaryText}>ACEPTAR SERVICIO</Text>
                  </TouchableOpacity>
                )}
                {b.assigned_staff_id===session?.user?.id && b.status!=="completed" && (
                  <TouchableOpacity style={s.primary} onPress={()=>advanceBooking(b)}>
                    <Text style={s.primaryText}>
                      {b.status==="confirmed" ? "MARCAR: EN CAMINO" :
                       b.status==="on_the_way" ? "MARCAR: TRABAJO EN CURSO" :
                       b.status==="in_progress" ? "MARCAR: FINALIZADO" : "ACTUALIZAR"}
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={s.secondary} onPress={()=>Linking.openURL(`tel:${b.customer_phone}`)}>
                  <Text style={s.secondaryText}>LLAMAR AL CLIENTE</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.secondary} onPress={()=>openMaps(b.service_address)}>
                  <Text style={s.secondaryText}>ABRIR GPS</Text>
                </TouchableOpacity>
              </View>)}
            </>}

            {tab==="contacto" && <>
              <Text style={s.section}>Contacto rápido</Text>
              <TouchableOpacity style={s.whatsapp} onPress={openWhatsApp}><Text style={s.primaryText}>WHATSAPP</Text></TouchableOpacity>
              <TouchableOpacity style={s.primary} onPress={openCall}><Text style={s.primaryText}>LLAMAR {PHONE}</Text></TouchableOpacity>
              <TouchableOpacity style={s.secondary} onPress={()=>openMaps()}><Text style={s.secondaryText}>GPS / MAPAS</Text></TouchableOpacity>
            </>}
          </ScrollView>

          <View style={s.nav}>
            {([
              ["inicio","Inicio"],["reservar","Reservar"],["reserva","Mis reservas"],["planes","Planes"],
              ["contacto","Contacto"],["cuenta","Cuenta"],
              ...((role==="staff"||role==="admin") ? [["personal","Personal"]] : []),
              ...(role==="admin" ? [["admin","Admin"]] : [])
            ] as string[][]).map(([k,l])=>
              <TouchableOpacity key={k} style={s.navItem} onPress={()=>setTab(k as Tab)}><Text style={tab===k?s.navOn:s.navOff}>{l}</Text></TouchableOpacity>
            )}
          </View>
        </SafeAreaView>
      )}
    </>
  );
}

const s=StyleSheet.create({
  safe:{flex:1,backgroundColor:"#F5F8FA"},header:{backgroundColor:"#0B2E59",padding:12,flexDirection:"row",alignItems:"center",gap:12},
  logo:{width:62,height:62,borderRadius:31},brand:{fontSize:23,fontWeight:"800",color:"white"},tag:{fontSize:12,color:"#D7F6F3"},
  content:{padding:16,paddingBottom:100},hero:{backgroundColor:"#0B2E59",borderRadius:18,padding:20,marginBottom:18},
  heroTitle:{fontSize:26,fontWeight:"900",color:"white"},heroText:{fontSize:15,color:"#E7F6F6",lineHeight:21,marginVertical:10},
  section:{fontSize:22,fontWeight:"800",color:"#0B2E59",marginTop:8,marginBottom:12},grid:{flexDirection:"row",flexWrap:"wrap",gap:10},
  card:{width:"48%",backgroundColor:"white",borderRadius:14,padding:14,minHeight:86,justifyContent:"space-between"},cardTitle:{fontSize:15,fontWeight:"700",color:"#0B2E59"},small:{fontSize:12,color:"#2CA7A0",marginTop:8},
  primary:{backgroundColor:"#2AA7A1",padding:15,borderRadius:12,alignItems:"center",marginTop:12},primaryText:{color:"white",fontWeight:"900"},
  secondary:{borderWidth:1,borderColor:"#0B2E59",padding:13,borderRadius:12,alignItems:"center",marginTop:10},secondaryText:{color:"#0B2E59",fontWeight:"800"},
  whatsapp:{backgroundColor:"#159447",padding:15,borderRadius:12,alignItems:"center",marginTop:12},label:{fontSize:13,fontWeight:"700",color:"#38506B",marginBottom:6},
  option:{padding:12,borderRadius:10,backgroundColor:"white",borderWidth:1,borderColor:"#DDE4EA",marginBottom:7},optionActive:{backgroundColor:"#2AA7A1",borderColor:"#2AA7A1"},
  optionText:{color:"#38506B"},optionTextActive:{color:"white",fontWeight:"800"},input:{backgroundColor:"white",borderWidth:1,borderColor:"#D9E1E8",borderRadius:12,padding:13,marginTop:10},
  infoBox:{backgroundColor:"white",padding:16,borderRadius:14},booking:{backgroundColor:"white",padding:16,borderRadius:14,marginBottom:12},bookingCode:{fontSize:18,fontWeight:"900",color:"#0B2E59"},
  bookingLine:{color:"#38506B",marginTop:4},planCard:{backgroundColor:"white",padding:18,borderRadius:16,marginBottom:12},planName:{fontSize:22,fontWeight:"900",color:"#0B2E59"},planDesc:{color:"#53677C",marginTop:4},
  nav:{position:"absolute",left:0,right:0,bottom:0,backgroundColor:"white",borderTopWidth:1,borderTopColor:"#E5E9ED",flexDirection:"row",paddingTop:12,paddingBottom:Platform.OS==="android"?32:12},
  navItem:{flex:1,alignItems:"center"},navOn:{fontSize:10,fontWeight:"900",color:"#0B2E59"},navOff:{fontSize:10,color:"#8492A0"},
  subsection:{fontSize:18,fontWeight:"900",color:"#0B2E59",marginTop:18,marginBottom:10},
  staffChip:{paddingVertical:9,paddingHorizontal:12,borderRadius:18,borderWidth:1,borderColor:"#C8D3DE",marginRight:8,backgroundColor:"white"},
  staffChipActive:{backgroundColor:"#2AA7A1",borderColor:"#2AA7A1"},staffChipText:{color:"#38506B"},staffChipTextActive:{color:"white",fontWeight:"800"},
  statusChip:{paddingVertical:9,paddingHorizontal:12,borderRadius:18,borderWidth:1,borderColor:"#C8D3DE",marginRight:8,backgroundColor:"white"},
  statusChipActive:{backgroundColor:"#0B2E59",borderColor:"#0B2E59"},statusChipText:{color:"#38506B"},statusChipTextActive:{color:"white",fontWeight:"800"},
  adminRow:{backgroundColor:"white",padding:14,borderRadius:12,marginBottom:8,flexDirection:"row",alignItems:"center",justifyContent:"space-between"},
  adminTitle:{fontSize:15,fontWeight:"800",color:"#0B2E59"},adminMuted:{fontSize:12,color:"#64778B",marginTop:3},
  smallButton:{backgroundColor:"#2AA7A1",paddingVertical:9,paddingHorizontal:13,borderRadius:9},smallButtonText:{color:"white",fontWeight:"900"}
});
