/* eslint-disable no-underscore-dangle */
/* eslint-disable import/no-named-as-default */
/* eslint-disable import/no-named-as-default-member */

import _ from 'lodash';
import moment from 'moment-timezone';
import Mixpanel from 'mixpanel';
import Dates from './Dates.js';
import mpTokens from '../tokens/mixpanel-tokens.js';
import connect from './connect.js';
import pkg from './dataset.js';

moment.tz.setDefault('Europe/Prague');

const {
  target,
  databasePage,
  pageLimit,
  timeout,
  dateForUpdate,
  workDays,
  deals,
  contactsFieldsId,
  funnels,
  finished,
  cornerCases,
  startingTimecut,
  stoppingTimecut,
  eventsTimeGap,
} = pkg;

const stageChangeQuery = {
  leads_statuses: [
    { pipeline_id: deals.id, status_id: deals.full },
    { pipeline_id: deals.id, status_id: deals.demo },
  ],
};

const statuses = [
  { pipeline_id: deals.id, status_id: finished },
  { pipeline_id: deals.id, status_id: deals.full },
  { pipeline_id: deals.id, status_id: deals.demo },
  { pipeline_id: deals.id, status_id: deals.full_prolong },
  { pipeline_id: deals.id, status_id: deals.demo_prolong },
  { pipeline_id: deals.id, status_id: deals.hold },
];

const mixpanelToken = mpTokens[`${target}`].token;
const mixpanelSecret = mpTokens[`${target}`].secret;

const mixpanelImporter = Mixpanel.init(
  mixpanelToken,
  {
    secret: mixpanelSecret,
    debug: true,
    verbose: true,
  },
);

const crm = connect();

const addLeadsStats = async (pageNum) => {
  console.log(`addLeadsStats FUNCTION for page #${pageNum} is run`);
  const statsWithLeads = [];
  await crm.request
    .get('/api/v4/leads', {
      page: pageNum,
      limit: pageLimit,
      with: 'contacts',
      filter: {
        statuses,
      },
    })
    .then(({ data }) => {
      if (!data) return;
      if (data.status === 401) {
        console.log(`${data.title}: ${data.detail}`);
        process.exit(0);
      }
      const { _embedded } = data;
      const { leads } = _embedded;

      leads.forEach((lead) => {
        const { _embedded: embedded } = lead;
        const { contacts: contact } = embedded;
        let customerId = 0;
        if (!contact.length) return;
        if (contact.length === 1) customerId = [contact[0].id];
        if (contact.length > 1) customerId = contact.map((item) => item.id);

        statsWithLeads.push(
          {
            lead: {
              lead_id: lead.id,
              created_at: lead.created_at * 1000,
              status_id: lead.status_id,
              pipeline_id: lead.pipeline_id,
            },
            customer: {
              customer_id: customerId,
            },
          },
        );
      });
    })
    .catch((error) => console.log('There is an Error: ', error));

  return statsWithLeads.length
    ? [...statsWithLeads, ...(await addLeadsStats(pageNum + 1))]
    : [];
};

const addCustomersStats = async (statsWithLeads) => {
  console.log('addCustomersStats FUNCTION is run \n');
  const statsWithCustomers = [...statsWithLeads];
  statsWithCustomers.forEach(async (item) => {
    const { customer } = item;
    const { customer_id: customerId } = customer;
    const [id] = customerId;

    await crm.request
      .get(`/api/v4/contacts/${id}`, {
        with: 'contacts',
      })
      .then(({ data }) => {
        const [firstName, lastName] = _.split(data.name, ' ');
        customer.first_name = firstName;
        customer.last_name = lastName || 'unknown';

        const { custom_fields_values: fields } = data;
        if (!fields) return;

        fields.forEach((field) => {
          const { field_id: fieldId } = field;
          const [value] = field.values;
          switch (fieldId) {
            case contactsFieldsId.email:
              customer.email = value.value;
              break;
            case contactsFieldsId.phone:
              customer.phone = value.value;
              break;
            case contactsFieldsId.address:
              customer.address = value.value;
              break;
            default:
              break;
          }
        });
      })
      .catch((error) => console.log('ERROR: ', error));
  });
  return statsWithCustomers;
};

const addEventsStats = async (statsWithCustomers) => {
  console.log('addEventsStats FUNCTION is run \n');
  const statsWithEvents = [...statsWithCustomers];

  const returnResultAfterPause = (response) => new Promise((resolve) => {
    setTimeout(() => {
      resolve(_.filter(response, 'lead.event_dates'));
    }, timeout);
  });

  statsWithEvents.forEach(async (statItem) => {
    const { lead } = statItem;
    const { lead_id: id } = lead;
    const datesStat = [];

    await crm.request
      .get('/api/v4/events', {
        filter: {
          entity: 'lead',
          entity_id: id,
          type: 'lead_status_changed',
          value_after: stageChangeQuery,
        },
      })
      .then(async ({ data }) => {
        if (!data || !data._embedded) return;
        const { _embedded } = data;
        const { events } = _embedded;
        events.forEach((event) => datesStat.push(moment(event.created_at * 1000).tz('Europe/Prague')));

        await crm.request
          .get('/api/v4/events', {
            filter: {
              entity: 'lead',
              entity_id: id,
              type: 'lead_status_changed',
              value_before: stageChangeQuery,
            },
          })
          .then(({ data: $data }) => {
            if ($data) {
              const { _embedded: $embedded } = $data;
              const { events: $events } = $embedded;
              $events.forEach((event) => datesStat.push(moment(event.created_at * 1000).tz('Europe/Prague')));
            }
            lead.event_dates = datesStat;
          })
          .catch((error) => console.log(error));
      })
      .catch((error) => console.log(error));
  });
  return returnResultAfterPause(statsWithEvents);
};

const buildWorkDates = (chunked) => {
  const [begin] = chunked;
  let end = '';
  if (chunked[1]) {
    [, end] = chunked;
  } else {
    end = Dates.todayEndingTimestamp;
  }

  const iter = (newBegin) => {
    const workDates = [];
    if (Dates.dateToString(newBegin) >= Dates.dateToString(end)) {
      if (Dates.dateToTime(end) > stoppingTimecut) {
        // next directive with 'eventsTimeGap' does exclude
        // the pair of the two nearest events if
        // there is less then 5 minutes gap between them (no fake events)
        if (moment(end) - moment(begin) > eventsTimeGap) { // link to 'begin' is correct!
          if (workDays.includes(Dates.dateToWeekday(newBegin))) {
            workDates.push(Dates.dateToString(newBegin));
          } else {
            return workDates;
          }
        }
      } else {
        return workDates;
      }
      // this directive fixes the problem of doubled final working dates
      return workDates;
    }
    if (Dates.dateToString(newBegin) === Dates.dateToString(begin)) {
      if (Dates.dateToTime(newBegin) < startingTimecut) {
        if (workDays.includes(Dates.dateToWeekday(newBegin))) {
          workDates.push(Dates.dateToString(newBegin));
        }
      }
    } else if (Dates.dateToString(newBegin) > Dates.dateToString(begin)) {
      if (workDays.includes(Dates.dateToWeekday(newBegin))) {
        workDates.push(Dates.dateToString(newBegin));
      }
    }
    const nextNewBegin = Dates.datePlusOneDay(newBegin);
    return [...workDates, ...iter(nextNewBegin)];
  };

  const result = iter(begin);
  return result;
};

const addWorkDatesStats = (statsWithEvents) => {
  console.log('addWorkDatesStats FUNCTION is run \n');
  const statsWithWorkDates = [...statsWithEvents];

  statsWithWorkDates.forEach((item) => {
    const workDates = [];
    const chunkedDates = [];
    const { lead } = item;
    const { lead_id: id, event_dates: events } = lead;

    if (_.has(cornerCases, id)) {
      chunkedDates.push(..._.chunk(cornerCases[id], 2));
    } else {
      events.sort((a, b) => a - b);
      chunkedDates.push(..._.chunk(events, 2));
    }

    chunkedDates.forEach((chunked) => {
      const result = buildWorkDates(chunked);
      workDates.push(...result);
    });
    lead.work_dates = workDates;
  });
  return statsWithWorkDates;
};

const customersUniquify = (collection) => {
  const unifiedColl = [];

  collection.forEach(({ lead, customer }) => {
    const lastProductionDate = _.last(lead.work_dates) || null;
    const [id] = customer.customer_id;

    if (_.some(unifiedColl, ['id', id])) {
      const foundCustomer = _.find(unifiedColl, ['id', id]);
      if (foundCustomer.last_date < lastProductionDate) {
        foundCustomer.last_date = lastProductionDate;
      }
    } else {
      unifiedColl.push(
        {
          id,
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email,
          phone: customer.phone,
          last_date: lastProductionDate,
        },
      );
    }
  });
  return unifiedColl;
};

const importUsers = (collection) => {
  const unifiedColl = customersUniquify(collection);

  unifiedColl.forEach((customer) => {
    const fullName = customer.last_name !== 'unknown'
      ? `${customer.first_name} ${customer.last_name}`
      : `${customer.first_name}`;

    mixpanelImporter.people.set(customer.id, {
      _id: customer.id,
      $first_name: customer.first_name,
      $last_name: customer.last_name,
      _full_name: fullName,
      $email: customer.email,
      $phone: customer.phone,
      _last_date: customer.last_date,
    });
  });
  console.log('Stats of Users for Import: ', unifiedColl.length, '\n');
};

const splitLeadsToEvents = (collection) => {
  const splitedEvents = [];
  collection.forEach(({ lead, customer }) => {
    const { work_dates: dates } = lead;

    dates.forEach((date) => {
      if (date === dateForUpdate) {
        const pipeline = _.findKey(funnels, (item) => item.id === lead.pipeline_id);

        splitedEvents.push({
          event: 'Vyroba',
          properties: {
            $insert_id: `${lead.lead_id}-${date}`,
            distinct_id: customer.customer_id[0],
            // time: date, // human readable value specially for dump
            time: Dates.dateToTimestamp(`${date} 00:01`),
            lead_id: lead.lead_id,
            pipeline,
          },
        });
      }
    });
  });
  return splitedEvents;
};

const importEvents = (collection) => {
  const splitedEvents = splitLeadsToEvents(collection);
  console.log('Stats of Splited Events for Import: ', splitedEvents.length, '\n');
  mixpanelImporter.import_batch(splitedEvents);
};

export default async () => {

  await crm.connection.refreshToken();

  const statsWithLeads = await addLeadsStats(databasePage);
  if (statsWithLeads.length === 0) return;
  console.log('Stats With Leads | length: ', statsWithLeads.length);

  const statsWithCustomers = await addCustomersStats(statsWithLeads);
  console.log('Stats With Customers | length: ', statsWithCustomers.length);

  const statsWithEvents = await addEventsStats(statsWithCustomers);
  console.log('Stats With Events | length: ', statsWithEvents.length);

  const statsWithWorkDates = addWorkDatesStats(statsWithEvents);
  console.log('Stats With WorkDates | length: ', statsWithWorkDates.length);

  importUsers(statsWithWorkDates);
  importEvents(statsWithWorkDates);

  // LOG full data set
  // console.log('Stats With WorkDates | result: ', statsWithWorkDates, '\n');
};
