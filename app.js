/* IMPORTS */
const events = require('events');
const express = require('express');
const fetch = require('node-fetch');
const { createEventAdapter } = require('@slack/events-api');
const { createMessageAdapter } = require('@slack/interactive-messages');
const { WebClient } = require('@slack/web-api');

/* GLOBAL VARIABLES */
const app = express();
const port = process.env.PORT || 8080;
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);
const slackClient = new WebClient(process.env.SLACK_TOKEN);
const covidAPI = 'http://corona-api.com/countries/COUNTRY_CODE';
const flagsAPI = 'https://www.countryflags.io/COUNTRY_CODE/flat/64.png';
const countries = {};
const countryEvents = new events.EventEmitter();
const beginHealthCheck = 60000; // ms after start

/* SLACK EVENTS: Register listener */
app.use('/events', slackEvents.requestListener());

/* SLACK EVENTS: Listen to app mentions */
slackEvents.on('app_mention', async event => {
    console.log(`Received mention by ${event.user}: ${event.text}`);

    // Post country data to channel
    postCountryData(event.text.split(' ')[1], event.channel);

});

/* SLACK INTERACTIONS: Register listener */
app.use('/interactions', slackInteractions.requestListener());

/* SLACK INTERACTIONS: Listen to actions */
slackInteractions.action({}, (payload, respond) => {
    console.log(`Received interaction: ${payload.type}`);

    // Respond to block actions
    if (payload.type === 'block_actions') {
        for (const action of payload.actions) {
            switch (action.action_id) {

                // Respond the subscribe action
                case 'pandemico_subscribe':

                    // Subscribe user
                    setUserSubscribed(action.value, payload.user.id, true);

                    respond({
                        text: `User subscribed: ${payload.user.username} to ${action.value}`,
                        response_type: 'ephemeral',
                        replace_original: false
                    });
                    break;

                // Respond the unsubscribe action
                case 'pandemico_unsubscribe':

                    // Unsubscribe user
                    setUserSubscribed(action.value, payload.user.id, false);

                    respond({
                        text: `User unsubscribed: ${payload.user.username} from ${action.value}`,
                        response_type: 'ephemeral',
                        replace_original: false
                    });
                    break;

                // Respond the close action
                case 'pandemico_close':

                    // Close country
                    setCountryClosed(action.value, true);

                    respond({
                        text: `Country closed: ${action.value}`,
                        response_type: 'ephemeral',
                        replace_original: false
                    });
                    break;

                // Respond the open action
                case 'pandemico_open':

                    // Open country
                    setCountryClosed(action.value, false);

                    respond({
                        text: `Country opened: ${action.value}`,
                        response_type: 'ephemeral',
                        replace_original: false
                    });
                    break;

                // Respond the health check action
                case 'pandemico_health_check':

                    // Open health check
                    openHealthCheck(payload.trigger_id);
                    break;

                // Respond the unknown action
                default:

                    respond({
                        text: `Sorry, I don't recognize this action: ${action}`,
                        response_type: 'ephemeral',
                        replace_original: false
                    });
            }
        }

    // Respond the view submissions
    } else if (payload.type === 'view_submission') {

        respond({
            text: 'Thank you for completing your health check!',
            response_type: 'ephemeral',
            replace_original: false
        });

    // Respond the unknown interaction types
    } else {

        respond({
            text: `Sorry, I don't recognize this type of interaction: ${payload.type}`,
            response_type: 'ephemeral',
            replace_original: false
        });

    }

});

/* COUNTRIES: Set country closed status */
const setCountryClosed = (country, close) => {

    // Check if change
    if (isCountryClosed(country) !== close) {

        // Change country closed status
        if (countries[country]) {
            countries[country].closed = close;
            countries[country].closed_ts = new Date();
        } else {
            countries[country] = {
                closed: close,
                closed_ts: new Date()
            };
        }

        // Notify change
        countryEvents.emit('change', country);

    }

};

/* COUNTRIES: Check whether country is closed */
const isCountryClosed = country => countries[country] ? countries[country].closed : false;

/* COUNTRIES: Post country data to Slack channel */
const postCountryData = async (country, channel) => {

    // Initialize data object
    let data = {};

    // Fetch country data from COVID API
    try {
        const response = await fetch(covidAPI.replace('COUNTRY_CODE', country));
        if (response.ok) {
            const json = await response.json();

            // Calculate active cases
            const active = json.data.latest_data.confirmed - json.data.latest_data.deaths - json.data.latest_data.recovered;

            // Assemble data object
            data = {
                country: json.data.name,
                population: json.data.population,
                updated: new Date(json.data.updated_at),
                deaths: {
                    today: json.data.today.deaths,
                    total: json.data.latest_data.deaths,
                    rate: Math.round((json.data.latest_data.deaths / json.data.population) * 10000) / 100
                },
                confirmed: {
                    today: json.data.today.confirmed,
                    total: json.data.latest_data.confirmed,
                    rate: Math.round((json.data.latest_data.confirmed / json.data.population) * 10000) / 100
                },
                active: {
                    total: active,
                    rate: Math.round((active / json.data.population) * 10000) / 100
                }
            };

        } else {
            console.log(response);
        }
    } catch (error) {
        console.log(error);
    }

    // Post country data to Slack channel
    slackClient.chat.postMessage({
        channel: channel,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `Latest data for ${data.country}:\n` +
                        "```Active:    " + ' '.repeat(7 - data.active.total.toString().length) +
                        data.active.total + " (" + data.active.rate + "%)\n" +
                        "Confirmed: " + ' '.repeat(7 - data.confirmed.total.toString().length) +
                        data.confirmed.total + " (" + data.confirmed.rate + "%) [Today: +" + data.confirmed.today + "]\n" +
                        "Deaths:    " + ' '.repeat(7 - data.deaths.total.toString().length) +
                        data.deaths.total + " (" + data.deaths.rate + "%) [Today: +" + data.deaths.today + "]```"
                },
                accessory: {
                    type: 'image',
                    image_url: flagsAPI.replace('COUNTRY_CODE', country),
                    alt_text: `flag for ${data.country}`
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Source: ${covidAPI.replace('COUNTRY_CODE', country)}\n` +
                            `Updated: ${data.updated}`
                    }
                ]
            },
            {
                type: 'divider'
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `Latest advice for ${data.country}:\n\n${isCountryClosed(country) ?
                        "      _*Please work from home and refrain from any travel.*_" :
                        "      _Please remain cautious and limit office visits and travel._"}`
                },
                accessory: {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: isCountryClosed(country) ? 'Open Country' : 'Close Country'
                    },
                    style: isCountryClosed(country) ? 'primary' : 'danger',
                    action_id: isCountryClosed(country) ? 'pandemico_open' : 'pandemico_close',
                    value: country
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Updated: ${countries[country] && countries[country].closed_ts ? countries[country].closed_ts : new Date()}`
                    }
                ]
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: isUserSubscribed(country, channel) ? 'Unsubscribe' : 'Subscribe'
                        },
                        action_id: isUserSubscribed(country, channel) ? 'pandemico_unsubscribe' : 'pandemico_subscribe',
                        value: country
                    }
                ]
            }
        ]
    });
};

/* COUNTRIES: Listen to country changes */
countryEvents.on('change', country => {

    // Notify subscribers of change
    if (countries[country] && countries[country].subscribers) {
        for (const subscriber of countries[country].subscribers) {
            postCountryData(country, subscriber);
        }
    }

});

/* SUBSCRIPTIONS: Set user subscribed status */
const setUserSubscribed = (country, user, subscribe) => {

    // Check if change
    if (isUserSubscribed(country, user) !== subscribe) {

        // Subscribe
        if (subscribe) {
            if (countries[country]) {
                if (countries[country].subscribers) {
                    countries[country].subscribers.push(user);
                } else {
                    countries[country].subscribers = [user];
                }
            } else {
                countries[country] = {
                    subscribers: [user]
                };
            }

            // Post country data to user
            postCountryData(country, user);

            // Unsubscribe
        } else if (countries[country] && countries[country].subscribers) {
            countries[country].subscribers.splice(countries[country].subscribers.indexOf(user), 1);
        }

    }

};

/* SUBSCRIPTIONS: Check whether user is subscribed */
const isUserSubscribed = (country, user) => countries[country] && countries[country].subscribers ? countries[country].subscribers.includes(user) : false;

/* HEALTH CHECK: Start Slack team health check */
const startHealthCheck = async () => {
    console.log('Initiated health check');

    // Post health check to every user
    for await (const page of slackClient.paginate('users.list')) {
        for (const member of page.members) {
            postHealthCheck(member.id);
        }
    }
}

/* HEALTH CHECK: Post health check to user */
const postHealthCheck = async user => {
    slackClient.chat.postMessage({
        channel: user,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: 'Please perform your regular health check.'
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: 'Start Health Check'
                        },
                        action_id: 'pandemico_health_check',
                        value: user
                    }
                ]
            }
        ]
    });
}

/* HEALTH CHECK: Open health check modal TODO FIX */
const openHealthCheck = trigger_id => {
    slackClient.views.open({
        trigger_id: trigger_id,
        view: {
            type: 'modal',
            title: {
                type: "plain_text",
                text: "Health Check"
            },
            submit: {
                type: "plain_text",
                text: "Submit"
            },
            close: {
                type: "plain_text",
                text: "Cancel"
            },
            blocks: [
                {
                    type: "input",
                    element: {
                        type: "plain_text_input"
                    },
                    label: {
                        type: "plain_text",
                        text: "Current health status"
                    }
                },
                {
                    type: 'input',
                    label: {
                        type: 'plain_text',
                        text: 'Please check applicable statements'
                    },
                    element: {
                        type: 'checkboxes',
                        options: [
                            {
                                text: {
                                    type: 'plain_text',
                                    text: 'I had COVID19 and recovered.'
                                },
                                value: 'recovered'
                            },
                            {
                                text: {
                                    type: 'plain_text',
                                    text: 'I received a COVID19 vaccine.'
                                },
                                value: 'vaccinated'
                            }
                        ]
                    }
                }
            ]
        }
    });
}

/* EXPRESS: Start server */
app.listen(port, () => {
    console.log(`Listening on port ${port}`);

    // Schedule team health check
    setTimeout(startHealthCheck, beginHealthCheck);
});